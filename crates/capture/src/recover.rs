//! Crash recovery: turn a recording folder that was killed mid-run into a valid `.marz` project.
//!
//! A running recording keeps a `.recording` marker holding the `ProjectMeta` known at start.
//! If `project.json` never appeared, the recorder died and `recover` rebuilds it from what is on disk.

use crate::CaptureError;
use crate::project::{CRASH_MARKER, LiveZoomMark, MicMeta, ProjectMeta, live_zooms, write_project_json};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

const WAV_HEADER_BYTES: u64 = 44;
const WAV_RATE: i64 = 48_000;
const WAV_BLOCK_BYTES: u64 = 2;
/// `system.wav` is stereo.
const SYSTEM_BLOCK_BYTES: u64 = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct RecoverReport {
    pub duration_us: i64,
}

/// True when the marker is present and `project.json` is not.
pub fn needs_recovery(dir: &Path) -> bool {
    dir.join(CRASH_MARKER).exists() && !dir.join("project.json").exists()
}

fn invalid(msg: impl Into<String>) -> CaptureError {
    CaptureError::Io(io::Error::new(io::ErrorKind::InvalidData, msg.into()))
}

/// Rebuild `project.json` for a recording that was killed. Raw tracks are only touched to patch
/// the WAV header sizes, which the engine only writes when it finishes.
pub fn recover(dir: &Path, ffprobe: &Path) -> Result<RecoverReport, CaptureError> {
    let marker = std::fs::read_to_string(dir.join(CRASH_MARKER))?;
    let mut meta: ProjectMeta = serde_json::from_str(&marker).map_err(|e| invalid(format!("unreadable crash marker: {e}")))?;

    let screen_us = screen_duration_us(ffprobe, &dir.join("screen.mp4"), meta.fps)?;

    // The mic track only counts when the marker says one was recorded and the file holds samples
    // (a kill before the first packet leaves a bare header or less).
    let mic_path = dir.join("mic.wav");
    let mic_us = if meta.mic.is_some() && mic_path.exists() { patch_wav(&mic_path, WAV_BLOCK_BYTES)? } else { None };
    let has_mic = mic_us.is_some_and(|us| us > 0);
    meta.mic = if has_mic { Some(meta.mic.take().unwrap_or(MicMeta { offset_us: 0 })) } else { None };
    // The computer's sound starts at t0; a kill before its first packet leaves a bare header.
    let system_path = dir.join("system.wav");
    let system_us = if meta.system_audio && system_path.exists() { patch_wav(&system_path, SYSTEM_BLOCK_BYTES)? } else { None };
    meta.system_audio = system_us.is_some_and(|us| us > 0);

    // The screen sets the length (on the recording clock, from t0). A shorter mic is padded with
    // silence by the editor and the export, as after a device loss.
    let duration_us = meta.screen_offset_us.max(0) + screen_us;
    let marks = read_zoom_marks(&dir.join("events.jsonl"));
    meta.duration_us = duration_us;
    meta.zooms = live_zooms(&marks, &meta.presets, duration_us);

    write_project_json(dir, &meta)?;
    std::fs::remove_file(dir.join(CRASH_MARKER))?;
    Ok(RecoverReport { duration_us })
}

/// Length of a truncated fragmented MP4: the last packet's time plus one frame. The container
/// duration is unreliable when the file was cut mid-fragment, so read the packet times instead.
pub fn screen_duration_us(ffprobe: &Path, screen: &Path, fps: u32) -> Result<i64, CaptureError> {
    let out = crate::ffmpeg::command(ffprobe)
        .args(["-v", "error", "-show_entries", "packet=pts_time", "-select_streams", "v:0", "-of", "csv=p=0"])
        .arg(screen)
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text
        .lines()
        .filter_map(|line| line.trim().trim_end_matches(',').parse::<f64>().ok())
        .fold(None, |best: Option<f64>, t| Some(best.map_or(t, |b| b.max(t))));
    let Some(last) = last else {
        return Err(CaptureError::Encoder("screen.mp4 has no readable video packets".into()));
    };
    Ok((last * 1_000_000.0).round() as i64 + 1_000_000 / i64::from(fps.max(1)))
}

/// Fix the sizes in the 44-byte header from the real file length, dropping a trailing partial
/// sample. Returns the audio length in microseconds, or None when the file holds no header.
fn patch_wav(path: &Path, block: u64) -> Result<Option<i64>, CaptureError> {
    let len = std::fs::metadata(path)?.len();
    if len < WAV_HEADER_BYTES {
        return Ok(None);
    }
    let data = (len - WAV_HEADER_BYTES) / block * block;
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    file.set_len(WAV_HEADER_BYTES + data)?;
    file.seek(SeekFrom::Start(4))?;
    file.write_all(&((36 + data) as u32).to_le_bytes())?;
    file.seek(SeekFrom::Start(40))?;
    file.write_all(&(data as u32).to_le_bytes())?;
    file.sync_all()?;
    let samples = (data / block) as i64;
    Ok(Some(samples * 1_000_000 / WAV_RATE))
}

/// Replay the zoom lines of `events.jsonl`. A line that does not parse (a half-written last line)
/// is skipped. A missing file means no marks.
fn read_zoom_marks(path: &Path) -> Vec<LiveZoomMark> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| v["type"] == "zoom")
        .filter_map(|v| {
            let t_us = v["tUs"].as_i64()?;
            match v["action"].as_str()? {
                "in" => Some(LiveZoomMark { t_us, preset_id: Some(v["presetId"].as_str()?.to_string()), rect: None }),
                "out" => Some(LiveZoomMark { t_us, preset_id: None, rect: None }),
                _ => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::{find_ffmpeg, find_ffprobe};
    use crate::project::{MicMeta, NormRect, ProjectMeta, ZoomPreset, write_crash_marker};
    use serde_json::Value;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("marz-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn start_meta(with_mic: bool) -> ProjectMeta {
        ProjectMeta {
            id: "killed-0001".into(),
            name: "Killed".into(),
            created_at: "2026-11-17T10:00:00Z".into(),
            duration_us: 0,
            width: 320,
            height: 180,
            fps: 30,
            screen_offset_us: 0,
            mic: with_mic.then_some(MicMeta { offset_us: 0 }),
            system_audio: false,
            cursor_hidden: false,
            presets: vec![ZoomPreset { id: "p1".into(), name: "Editor".into(), rect: NormRect { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
            zooms: vec![],
        }
    }

    fn wav_with_zero_sizes(data_bytes: usize) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&48_000u32.to_le_bytes());
        b.extend_from_slice(&96_000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend(std::iter::repeat_n(0u8, data_bytes));
        b
    }

    /// Builds a killed recording folder. Returns None (with a note) when FFmpeg is missing.
    fn killed_folder(tag: &str, mic_seconds: Option<usize>) -> Option<(PathBuf, PathBuf)> {
        let (ffmpeg, ffprobe) = match (find_ffmpeg(), find_ffprobe()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => {
                eprintln!("skipping {tag}: ffmpeg/ffprobe not found");
                return None;
            }
        };
        let dir = temp_dir(tag);
        let screen = dir.join("screen.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "15"])
            .args(["-movflags", "frag_keyframe+empty_moov+default_base_moof"])
            .arg(&screen)
            .status()
            .unwrap();
        assert!(status.success(), "ffmpeg could not make the test clip");
        // Kill it mid-fragment: keep about 70 percent of the file.
        let bytes = std::fs::read(&screen).unwrap();
        std::fs::write(&screen, &bytes[..bytes.len() * 7 / 10]).unwrap();

        if let Some(secs) = mic_seconds {
            // One odd trailing byte, as a kill mid-write can leave.
            std::fs::write(dir.join("mic.wav"), wav_with_zero_sizes(secs * 96_000 + 1)).unwrap();
        }
        let events = [
            r#"{"type":"header","version":1,"source":{"width":320,"height":180,"fps":30},"startedAt":"2026-11-17T10:00:00Z"}"#,
            r#"{"tUs":200000,"type":"zoom","presetId":"p1","action":"in"}"#,
            r#"{"tUs":900000,"type":"zoom","presetId":"p1","action":"out"}"#,
            r#"{"tUs":1200000,"type":"zoom","presetId":"p1","action":"in"}"#,
            r#"{"tUs":2900000,"type":"zoom","pres"#,
        ]
        .join("\n");
        std::fs::write(dir.join("events.jsonl"), events).unwrap();
        write_crash_marker(&dir, &start_meta(mic_seconds.is_some())).unwrap();
        Some((dir, ffprobe))
    }

    #[test]
    fn recovers_a_killed_recording() {
        let Some((dir, ffprobe)) = killed_folder("recover-killed", Some(3)) else { return };
        assert!(needs_recovery(&dir));
        let report = recover(&dir, &ffprobe).unwrap();

        // Duration within 1 s of the 3 s that were recorded.
        assert!((report.duration_us - 3_000_000).abs() <= 1_000_000, "duration {}", report.duration_us);
        assert!(!needs_recovery(&dir));
        assert!(!dir.join(crate::project::CRASH_MARKER).exists());

        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["durationUs"], report.duration_us);
        assert_eq!(v["source"]["width"], 320);
        assert_eq!(v["tracks"]["mic"]["file"], "mic.wav");
        // The broken last events line is dropped; the second zoom runs to the end.
        let zooms = v["edits"]["zooms"].as_array().unwrap();
        assert_eq!(zooms.len(), 2, "{zooms:?}");
        assert_eq!((zooms[0]["startUs"].as_i64(), zooms[0]["endUs"].as_i64()), (Some(200_000), Some(900_000)));
        assert_eq!(zooms[1]["startUs"], 1_200_000);
        assert_eq!(zooms[1]["endUs"], report.duration_us);

        // WAV header sizes are patched and match the file.
        let wav = std::fs::read(dir.join("mic.wav")).unwrap();
        let data = u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize;
        let riff = u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize;
        assert_eq!(wav.len(), 44 + data);
        assert_eq!(data % 2, 0);
        assert_eq!(riff, 36 + data);
        assert_eq!(data, 3 * 96_000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duration_follows_the_screen_not_a_shorter_mic() {
        // Mic stopped after 1 s while the screen file holds about 2 s: the video is not cut to the mic.
        let Some((dir, ffprobe)) = killed_folder("recover-short-mic", Some(1)) else { return };
        let screen_us = screen_duration_us(&ffprobe, &dir.join("screen.mp4"), 30).unwrap();
        let report = recover(&dir, &ffprobe).unwrap();
        assert!(screen_us > 1_000_000, "screen {screen_us}");
        assert_eq!(report.duration_us, screen_us);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap()).unwrap();
        assert_eq!(v["tracks"]["mic"]["file"], "mic.wav", "the short mic track is kept");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duration_adds_the_screen_offset() {
        let Some((dir, ffprobe)) = killed_folder("recover-offset", None) else { return };
        let mut meta = start_meta(false);
        meta.screen_offset_us = 250_000;
        write_crash_marker(&dir, &meta).unwrap();
        let screen_us = screen_duration_us(&ffprobe, &dir.join("screen.mp4"), 30).unwrap();
        let report = recover(&dir, &ffprobe).unwrap();
        assert_eq!(report.duration_us, 250_000 + screen_us);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_mic_without_samples_is_dropped() {
        // Killed before the first packet: a bare 44-byte header, or not even a whole header.
        for (tag, bytes) in [("recover-mic-header-only", wav_with_zero_sizes(0)), ("recover-mic-short", vec![b'R', b'I', b'F', b'F', 0, 0])] {
            let Some((dir, ffprobe)) = killed_folder(tag, None) else { return };
            std::fs::write(dir.join("mic.wav"), bytes).unwrap();
            write_crash_marker(&dir, &start_meta(true)).unwrap();
            let report = recover(&dir, &ffprobe).unwrap();
            assert!(report.duration_us > 1_000_000, "{tag}: duration {}", report.duration_us);
            let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap()).unwrap();
            assert!(v["tracks"].get("mic").is_none(), "{tag}: {v}");
            assert_eq!(v["durationUs"], report.duration_us);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn recovers_without_a_mic() {
        let Some((dir, ffprobe)) = killed_folder("recover-no-mic", None) else { return };
        let report = recover(&dir, &ffprobe).unwrap();
        assert!(report.duration_us > 1_000_000, "duration {}", report.duration_us);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap()).unwrap();
        assert!(v["tracks"].get("mic").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finished_recording_does_not_need_recovery() {
        let dir = temp_dir("recover-finished");
        assert!(!needs_recovery(&dir)); // no marker
        std::fs::write(dir.join(crate::project::CRASH_MARKER), "{}").unwrap();
        assert!(needs_recovery(&dir));
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        assert!(!needs_recovery(&dir)); // project.json present
        std::fs::remove_dir_all(&dir).ok();
    }
}
