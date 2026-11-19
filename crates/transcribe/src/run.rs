//! The whole transcription of one project: a 16 kHz copy of `mic.wav`, sections at pauses,
//! whisper.cpp per section, merged words, `transcript.json`.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::sections::{
    DEFAULT_MAX_LEN_US, DEFAULT_MIN_LEN_US, DEFAULT_MIN_PAUSE_US, LEVEL_STEP_US, read_wav_mono16, split_sections, wav_levels,
    write_wav_mono16,
};
use crate::transcript::{Section, Transcript, Word, mic_stamp, write_transcript};
use crate::whisper::{FILLER_PROMPT, parse_whisper_json, whisper_args};

/// Whisper's input rate.
pub const WHISPER_RATE: u32 = 16_000;
/// A word that starts this much before the previous word ends is a duplicate from a section edge.
pub const OVERLAP_TOLERANCE_US: i64 = 50_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum TranscribeError {
    NoWhisper,
    NoModel,
    NoMic,
    Failed(String),
    Cancelled,
}

impl fmt::Display for TranscribeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoWhisper => f.write_str("Whisper is missing. Install it or set MARZ_WHISPER."),
            Self::NoModel => f.write_str("The transcription model is missing."),
            Self::NoMic => f.write_str("This recording has no mic track."),
            Self::Failed(msg) => write!(f, "Transcription failed: {msg}"),
            Self::Cancelled => f.write_str("Transcription was cancelled."),
        }
    }
}

impl std::error::Error for TranscribeError {}

/// A `Command` that never flashes a console window on Windows.
fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Sections `(start_us, end_us)` in file time for 16-bit mono PCM, with the default pause and lengths.
pub fn plan_sections(pcm: &[i16], rate: u32) -> Vec<(i64, i64)> {
    let levels = wav_levels(pcm, rate, LEVEL_STEP_US);
    let mut s = split_sections(&levels, LEVEL_STEP_US, DEFAULT_MIN_PAUSE_US, DEFAULT_MIN_LEN_US, DEFAULT_MAX_LEN_US);
    // The level grid rounds the last step up; end exactly at the audio's end.
    let end_us = pcm.len() as i64 * 1_000_000 / rate.max(1) as i64;
    if let Some(last) = s.last_mut() {
        last.1 = end_us.max(last.0);
    }
    s
}

/// The samples of `pcm` between two file times.
pub fn slice_pcm(pcm: &[i16], rate: u32, (start_us, end_us): (i64, i64)) -> &[i16] {
    let idx = |us: i64| ((us.max(0) as i128 * rate as i128 / 1_000_000) as usize).min(pcm.len());
    let (a, b) = (idx(start_us), idx(end_us));
    &pcm[a..b.max(a)]
}

/// Appends a section's words, dropping those that start before the last word of the earlier
/// sections ends minus 50 ms (duplicates at a section edge). Words inside one section keep
/// Whisper's own small overlaps (it often starts a word 30 to 70 ms before the last one ends).
pub fn append_words(words: &mut Vec<Word>, new: Vec<Word>) {
    let seam = words.last().map(|w| w.end_us - OVERLAP_TOLERANCE_US);
    words.extend(new.into_iter().filter(|w| seam.is_none_or(|s| w.start_us >= s)));
}

/// Runs `run_one(index, section)` for each section (it returns Whisper's JSON, or `None` when
/// Whisper wrote nothing), merges the words with ids that continue across sections from `w1`, and
/// builds the sections with their languages in source time. Checks `cancel` before each section
/// and reports progress after each one.
pub fn transcribe_sections(
    sections: &[(i64, i64)],
    mic_offset_us: i64,
    progress: &mut dyn FnMut(f32),
    cancel: &AtomicBool,
    run_one: &mut dyn FnMut(usize, (i64, i64)) -> Result<Option<String>, TranscribeError>,
) -> Result<(Vec<Section>, Vec<Word>), TranscribeError> {
    let mut words: Vec<Word> = Vec::new();
    let mut out: Vec<Section> = Vec::new();
    let mut next_id = 1usize;
    for (i, &sec) in sections.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(TranscribeError::Cancelled);
        }
        let (language, new) = match run_one(i, sec)? {
            Some(json) => parse_whisper_json(&json, sec.0, mic_offset_us, next_id).map_err(TranscribeError::Failed)?,
            None => ("und".to_string(), Vec::new()),
        };
        next_id += new.len();
        append_words(&mut words, new);
        out.push(Section { start_us: sec.0 + mic_offset_us, end_us: sec.1 + mic_offset_us, language });
        progress((i + 1) as f32 / sections.len() as f32);
    }
    Ok((out, words))
}

/// The engine label stored in `transcript.json`.
pub fn engine_label(model: &Path) -> String {
    let stem = model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    format!("whisper.cpp {stem}")
}

/// Deletes the run's temp folder however the run ends.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tail(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let s = s.trim();
    let start = s.char_indices().rev().nth(399).map(|(i, _)| i).unwrap_or(0);
    s[start..].to_string()
}

/// Transcribes `<dir>/mic.wav` and writes `<dir>/transcript.json`.
///
/// FFmpeg writes a 16 kHz mono copy into a fresh folder under `tmp`; that folder is deleted at the
/// end. Whisper runs once per section with `-l auto`. `mic_offset_us` (`tracks.mic.offsetUs`) maps
/// file time to source time. No `mic.wav` gives `NoMic` and writes nothing. `cancel` is checked
/// between sections (a running Whisper is not killed); a cancelled run writes nothing.
#[allow(clippy::too_many_arguments)]
pub fn run_transcription(
    dir: &Path,
    mic_offset_us: i64,
    whisper: &Path,
    model: &Path,
    vad: Option<&Path>,
    ffmpeg: &Path,
    tmp: &Path,
    progress: &mut dyn FnMut(f32),
    cancel: &AtomicBool,
) -> Result<Transcript, TranscribeError> {
    let mic = dir.join("mic.wav");
    if !mic.is_file() {
        return Err(TranscribeError::NoMic);
    }
    if !whisper.is_file() {
        return Err(TranscribeError::NoWhisper);
    }
    if !model.is_file() || vad.is_some_and(|v| !v.is_file()) {
        return Err(TranscribeError::NoModel);
    }
    let stamp = mic_stamp(&mic).map_err(|e| TranscribeError::Failed(format!("cannot read mic.wav: {e}")))?;

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = TempDir(tmp.join(format!("marz-transcribe-{}-{nanos}", std::process::id())));
    fs::create_dir_all(&work.0).map_err(|e| TranscribeError::Failed(format!("cannot create the temp folder: {e}")))?;
    progress(0.0);

    let wav16 = work.0.join("mic16k.wav");
    let out = command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&mic)
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav"])
        .arg(&wav16)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| TranscribeError::Failed(format!("cannot run ffmpeg: {e}")))?;
    if !out.status.success() {
        return Err(TranscribeError::Failed(format!("ffmpeg failed: {}", tail(&out.stderr))));
    }
    let (rate, pcm) = read_wav_mono16(&wav16).map_err(|e| TranscribeError::Failed(format!("cannot read the 16 kHz copy: {e}")))?;
    let _ = fs::remove_file(&wav16);
    let sections = plan_sections(&pcm, rate);

    let mut run_one = |i: usize, sec: (i64, i64)| -> Result<Option<String>, TranscribeError> {
        let wav = work.0.join(format!("s{i}.wav"));
        let base = work.0.join(format!("s{i}"));
        let json_path = work.0.join(format!("s{i}.json"));
        write_wav_mono16(&wav, rate, slice_pcm(&pcm, rate, sec))
            .map_err(|e| TranscribeError::Failed(format!("cannot write section {i}: {e}")))?;
        let out = command(whisper)
            .args(whisper_args(model, vad, &wav, &base, None, FILLER_PROMPT))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| TranscribeError::Failed(format!("cannot run whisper: {e}")))?;
        let _ = fs::remove_file(&wav);
        if !out.status.success() {
            return Err(TranscribeError::Failed(format!("whisper failed on section {}: {}", i + 1, tail(&out.stderr))));
        }
        let json = fs::read(&json_path).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        let _ = fs::remove_file(&json_path);
        Ok(json)
    };
    let (sections, words) = transcribe_sections(&sections, mic_offset_us, progress, cancel, &mut run_one)?;
    if cancel.load(Ordering::SeqCst) {
        return Err(TranscribeError::Cancelled);
    }

    let t = Transcript { version: 1, engine: engine_label(model), mic: stamp, sections, words };
    write_transcript(dir, &t).map_err(|e| TranscribeError::Failed(format!("cannot write transcript.json: {e}")))?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-run-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture(name: &str) -> String {
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)).unwrap()
    }

    /// Whisper JSON with one word per `(from_ms, to_ms, text)`.
    fn whisper_json(lang: &str, words: &[(i64, i64, &str)]) -> String {
        let segs: Vec<String> = words
            .iter()
            .map(|(a, b, t)| format!(r#"{{"offsets":{{"from":{a},"to":{b}}},"text":" {t}","tokens":[{{"text":" {t}","p":0.9}}]}}"#))
            .collect();
        format!(r#"{{"result":{{"language":"{lang}"}},"transcription":[{}]}}"#, segs.join(","))
    }

    #[test]
    fn word_ids_continue_across_sections() {
        let sections = [(0, 40_000_000), (40_000_000, 90_000_000), (90_000_000, 100_000_000)];
        let mut seen = Vec::new();
        let mut run_one = |i: usize, _sec: (i64, i64)| -> Result<Option<String>, TranscribeError> {
            Ok(match i {
                0 => Some(fixture("v_vad.json")),
                1 => Some(whisper_json("en", &[(0, 300, "So,"), (300, 600, "this")])),
                _ => None,
            })
        };
        let cancel = AtomicBool::new(false);
        let (secs, words) = transcribe_sections(&sections, 250_000, &mut |p| seen.push(p), &cancel, &mut run_one).unwrap();
        assert_eq!(words.len(), 39 + 2);
        for (n, w) in words.iter().enumerate() {
            assert_eq!(w.id, format!("w{}", n + 1));
        }
        assert_eq!(words[0].start_us, 4_140_000 + 250_000);
        assert_eq!(words[39].text, "So,");
        assert_eq!(words[39].start_us, 40_000_000 + 250_000);
        let langs: Vec<&str> = secs.iter().map(|s| s.language.as_str()).collect();
        assert_eq!(langs, ["pt", "en", "und"]);
        assert_eq!(secs[0].start_us, 250_000);
        assert_eq!(secs[2].end_us, 100_250_000);
        assert_eq!(seen.len(), 3);
        assert_eq!(*seen.last().unwrap(), 1.0);
    }

    #[test]
    fn drops_words_that_overlap_the_previous_section() {
        let sections = [(0, 10_000_000), (10_000_000, 20_000_000)];
        let mut run_one = |i: usize, _sec: (i64, i64)| -> Result<Option<String>, TranscribeError> {
            Ok(Some(match i {
                0 => whisper_json("pt", &[(9_000, 10_400, "longo")]),
                // Starts 400 ms before "longo" ends: dropped. Starts 30 ms before: kept, and so is
                // a word overlapping it by 70 ms inside the same section.
                _ => whisper_json("pt", &[(0, 200, "dup"), (370, 500, "ok"), (430, 600, "mesmo")]),
            }))
        };
        let cancel = AtomicBool::new(false);
        let (_, words) = transcribe_sections(&sections, 0, &mut |_| {}, &cancel, &mut run_one).unwrap();
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["longo", "ok", "mesmo"]);
        // Ids never repeat even when a word is dropped.
        assert_eq!(words[1].id, "w3");
    }

    #[test]
    fn cancel_stops_between_sections() {
        let sections = [(0, 10_000_000), (10_000_000, 20_000_000)];
        let cancel = AtomicBool::new(false);
        let mut calls = 0;
        let mut run_one = |_i: usize, _sec: (i64, i64)| -> Result<Option<String>, TranscribeError> {
            calls += 1;
            cancel.store(true, Ordering::SeqCst);
            Ok(None)
        };
        let r = transcribe_sections(&sections, 0, &mut |_| {}, &cancel, &mut run_one);
        assert_eq!(r, Err(TranscribeError::Cancelled));
        assert_eq!(calls, 1);
    }

    #[test]
    fn no_mic_track_skips_transcription() {
        let dir = temp_dir("nomic");
        let tmp = temp_dir("nomic-tmp");
        let cancel = AtomicBool::new(false);
        let mut called = false;
        let r = run_transcription(
            &dir,
            0,
            Path::new("missing-whisper.exe"),
            Path::new("missing.bin"),
            None,
            Path::new("ffmpeg"),
            &tmp,
            &mut |_| called = true,
            &cancel,
        );
        assert_eq!(r, Err(TranscribeError::NoMic));
        assert!(!called);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "nothing written to the project");
        assert_eq!(fs::read_dir(&tmp).unwrap().count(), 0, "nothing written to temp");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_whisper_or_model_is_reported_before_any_work() {
        let dir = temp_dir("tools");
        let tmp = temp_dir("tools-tmp");
        fs::write(dir.join("mic.wav"), b"x").unwrap();
        let fake = dir.join("fake-whisper.exe");
        fs::write(&fake, b"").unwrap();
        let cancel = AtomicBool::new(false);
        let r = run_transcription(&dir, 0, &dir.join("nope.exe"), &fake, None, Path::new("ffmpeg"), &tmp, &mut |_| {}, &cancel);
        assert_eq!(r, Err(TranscribeError::NoWhisper));
        let r = run_transcription(&dir, 0, &fake, &dir.join("nope.bin"), None, Path::new("ffmpeg"), &tmp, &mut |_| {}, &cancel);
        assert_eq!(r, Err(TranscribeError::NoModel));
        let r = run_transcription(&dir, 0, &fake, &fake, Some(&dir.join("nope.bin")), Path::new("ffmpeg"), &tmp, &mut |_| {}, &cancel);
        assert_eq!(r, Err(TranscribeError::NoModel));
        assert!(!dir.join("transcript.json").exists());
        assert_eq!(fs::read_dir(&tmp).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn plan_and_slice_line_up() {
        let rate = 16_000;
        let pcm: Vec<i16> = (0..rate * 5 / 2).map(|i| if i % 800 < 560 { 6000 } else { 0 }).collect();
        let s = plan_sections(&pcm, rate as u32);
        assert_eq!(s, vec![(0, 2_500_000)]);
        assert_eq!(slice_pcm(&pcm, rate as u32, (1_000_000, 1_500_000)).len(), 8000);
        assert_eq!(slice_pcm(&pcm, rate as u32, (2_000_000, 9_000_000)).len(), 8000);
        assert!(plan_sections(&[], rate as u32).is_empty());
    }

    #[test]
    fn errors_read_as_sentences() {
        assert_eq!(TranscribeError::NoWhisper.to_string(), "Whisper is missing. Install it or set MARZ_WHISPER.");
        assert_eq!(TranscribeError::Failed("x".into()).to_string(), "Transcription failed: x");
    }

    /// The real thing on this laptop: whisper.cpp CUDA build and the spike models in
    /// `%LOCALAPPDATA%\MarzSpike`, ffmpeg on PATH. Run with `cargo test -p marz-transcribe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_whisper_on_a_60_s_slice() {
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
            eprintln!("skipped: no LOCALAPPDATA");
            return;
        };
        let spike = local.join("MarzSpike");
        let whisper = std::env::var_os("MARZ_WHISPER")
            .map(PathBuf::from)
            .unwrap_or_else(|| spike.join("cuda").join("Release").join("whisper-cli.exe"));
        let model = spike.join("models").join(crate::models::MAIN_MODEL.name);
        let vad = spike.join("models").join(crate::models::VAD_MODEL.name);
        let source = spike.join("out").join("t1935.wav");
        if ![&whisper, &model, &vad, &source].iter().all(|p| p.is_file()) {
            eprintln!("skipped: spike files missing");
            return;
        }
        let dir = temp_dir("real");
        let tmp = temp_dir("real-tmp");
        let (rate, pcm) = read_wav_mono16(&source).unwrap();
        // MARZ_SLICE_SECS picks a longer slice (default 60 s) to exercise several sections.
        let len_s: i64 = std::env::var("MARZ_SLICE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
        let slice = slice_pcm(&pcm, rate, (30_000_000, (30 + len_s) * 1_000_000));
        write_wav_mono16(&dir.join("mic.wav"), rate, slice).unwrap();

        let cancel = AtomicBool::new(false);
        let mut steps = Vec::new();
        let started = std::time::Instant::now();
        let t = run_transcription(&dir, 123_000, &whisper, &model, Some(&vad), Path::new("ffmpeg"), &tmp, &mut |p| steps.push(p), &cancel)
            .unwrap();
        let secs = started.elapsed().as_secs_f64();
        eprintln!(
            "{len_s} s slice: {secs:.1} s wall, {} sections {:?}, {} words, progress {:?}",
            t.sections.len(),
            t.sections.iter().map(|s| (s.start_us, s.end_us, s.language.clone())).collect::<Vec<_>>(),
            t.words.len(),
            steps
        );
        eprintln!("first words: {:?}", t.words.iter().take(12).map(|w| (w.start_us, w.text.as_str())).collect::<Vec<_>>());
        if std::env::var_os("MARZ_DUMP_WORDS").is_some() {
            let dump: Vec<String> = t.words.iter().map(|w| format!("{} {} {}", w.start_us, w.end_us, w.text)).collect();
            fs::write(std::env::temp_dir().join("marz-real-words.txt"), dump.join("
")).unwrap();
        }
        assert!(t.words.len() as i64 > len_s);
        assert!(t.sections.iter().all(|s| s.language == "pt"));
        assert!(t.words.windows(2).all(|w| w[1].start_us >= w[0].start_us), "words in order");
        assert!(t.words.iter().all(|w| w.start_us >= 123_000 && w.end_us <= len_s * 1_000_000 + 123_000 + 500_000));
        assert!(crate::transcript::transcript_is_current(&dir, &dir.join("mic.wav")));
        assert_eq!(fs::read_dir(&tmp).unwrap().count(), 0, "temp files deleted");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&tmp);
    }
}
