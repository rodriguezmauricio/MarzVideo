//! Mic noise removal: a cleaned copy `cache/mic.clean.wav` next to the project's raw tracks, made
//! by FFmpeg and stamped with the `mic.wav` it came from. `mic.wav` is never touched. The preview
//! plays the copy and the export reads it (`MicJob::clean`).

use crate::tools::command;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::UNIX_EPOCH;

/// The cleaned copy, relative to the project folder.
pub const CLEAN_REL: &str = "cache/mic.clean.wav";
const STAMP: &str = "mic.clean.json";
/// No download needed: rumble cut below 80 Hz, FFT denoiser with noise tracking. Sample count in
/// equals sample count out, so sync holds.
pub const FFT_FILTER: &str = "highpass=f=80,afftdn=nr=20:nf=-50:tn=1";
/// File name of an RNNoise model; when it is in the models folder the speech model is used instead.
pub const RNNOISE_MODEL: &str = "rnnoise.rnnn";
/// The RNNoise filter. FFmpeg runs with the models folder as its working directory, so the model
/// path has no drive colon to escape.
pub const RNNOISE_FILTER: &str = "highpass=f=80,arnndn=m=rnnoise.rnnn";

pub fn cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("cache")
}

pub fn clean_path(project_dir: &Path) -> PathBuf {
    cache_dir(project_dir).join("mic.clean.wav")
}

/// Which `mic.wav` and which filter made the copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub version: u32,
    pub filter: String,
    pub mic: MicStamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicStamp {
    pub bytes: u64,
    pub modified_ms: u64,
}

pub fn stamp_of(mic: &Path, filter: &str) -> std::io::Result<Stamp> {
    let meta = std::fs::metadata(mic)?;
    let modified_ms = meta.modified()?.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Stamp { version: 1, filter: filter.to_string(), mic: MicStamp { bytes: meta.len(), modified_ms } })
}

/// Filter to use: RNNoise when its model is in `models_dir`, else the FFT denoiser.
pub fn pick_filter(models_dir: Option<&Path>) -> (&'static str, Option<PathBuf>) {
    match models_dir {
        Some(d) if d.join(RNNOISE_MODEL).is_file() => (RNNOISE_FILTER, Some(d.to_path_buf())),
        _ => (FFT_FILTER, None),
    }
}

/// Whether the copy exists and its stamp matches `mic` and `filter`.
pub fn is_fresh(project_dir: &Path, mic: &Path, filter: &str) -> bool {
    let Ok(want) = stamp_of(mic, filter) else { return false };
    let Ok(text) = std::fs::read_to_string(cache_dir(project_dir).join(STAMP)) else { return false };
    let Ok(have) = serde_json::from_str::<Stamp>(&text) else { return false };
    have == want && clean_path(project_dir).is_file()
}

/// FFmpeg arguments that write the cleaned copy of `input` to `output` (mono 16-bit, 48 kHz kept).
pub fn clean_args(input: &Path, output: &Path, filter: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-i"].iter().map(|s| s.to_string()).collect();
    a.push(input.to_string_lossy().into_owned());
    a.extend(["-af", filter, "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav"].iter().map(|s| s.to_string()));
    a.push(output.to_string_lossy().into_owned());
    a
}

/// Make the cleaned copy of `project_dir/<mic_file>` unless a fresh one is there. Writes to a temp
/// name, then renames, then writes the stamp. Returns the copy's path relative to the project.
pub fn ensure_clean(ffmpeg: &Path, project_dir: &Path, mic_file: &str, models_dir: Option<&Path>) -> Result<String, String> {
    let mic = project_dir.join(mic_file);
    if !mic.is_file() {
        return Err(format!("{mic_file} is missing"));
    }
    let (filter, cwd) = pick_filter(models_dir);
    if is_fresh(project_dir, &mic, filter) {
        return Ok(CLEAN_REL.to_string());
    }
    let dir = cache_dir(project_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the cache folder: {e}"))?;
    let tmp = dir.join("mic.clean.tmp.wav");
    let mut cmd = command(ffmpeg);
    cmd.args(clean_args(&mic, &tmp, filter)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("noise removal failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let _ = std::fs::remove_file(dir.join(STAMP));
    std::fs::rename(&tmp, clean_path(project_dir)).map_err(|e| format!("could not move the cleaned mic into place: {e}"))?;
    let stamp = stamp_of(&mic, filter).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(STAMP), serde_json::to_string_pretty(&stamp).unwrap_or_default()).map_err(|e| format!("could not write the stamp: {e}"))?;
    Ok(CLEAN_REL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::find_ffmpeg;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-clean-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn args_write_mono_pcm_with_the_filter() {
        let a = clean_args(Path::new("p/mic.wav"), Path::new("p/cache/x.wav"), FFT_FILTER).join(" ");
        assert!(a.contains("-af highpass=f=80,afftdn=nr=20:nf=-50:tn=1 -ac 1 -c:a pcm_s16le -f wav"), "{a}");
        assert!(a.ends_with("x.wav"), "{a}");
    }

    #[test]
    fn rnnoise_is_used_only_when_its_model_is_there() {
        let dir = temp_dir("model");
        assert_eq!(pick_filter(Some(&dir)).0, FFT_FILTER);
        assert_eq!(pick_filter(None).0, FFT_FILTER);
        std::fs::write(dir.join(RNNOISE_MODEL), b"x").unwrap();
        let (f, cwd) = pick_filter(Some(&dir));
        assert_eq!(f, RNNOISE_FILTER);
        assert_eq!(cwd.as_deref(), Some(dir.as_path()));
    }

    #[test]
    fn stamp_goes_stale_when_the_mic_or_filter_changes() {
        let dir = temp_dir("stamp");
        let mic = dir.join("mic.wav");
        std::fs::write(&mic, b"abc").unwrap();
        assert!(!is_fresh(&dir, &mic, FFT_FILTER));
        std::fs::create_dir_all(cache_dir(&dir)).unwrap();
        std::fs::write(clean_path(&dir), b"x").unwrap();
        let s = stamp_of(&mic, FFT_FILTER).unwrap();
        std::fs::write(cache_dir(&dir).join(STAMP), serde_json::to_string(&s).unwrap()).unwrap();
        assert!(is_fresh(&dir, &mic, FFT_FILTER));
        assert!(!is_fresh(&dir, &mic, RNNOISE_FILTER));
        std::fs::write(&mic, b"abcd").unwrap();
        assert!(!is_fresh(&dir, &mic, FFT_FILTER));
    }

    /// Real FFmpeg on a synthetic noisy take: noise drops, the tone holds, the length is unchanged,
    /// and `mic.wav` is untouched. Skipped when FFmpeg is not installed.
    #[test]
    fn cleans_a_noisy_take_and_keeps_its_length() {
        let Ok(ffmpeg) = find_ffmpeg() else { return };
        let dir = temp_dir("real");
        let mic = dir.join("mic.wav");
        // 4 s: a 300 Hz tone in the first second of every two, pink noise throughout.
        let st = command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:r=48000:d=4", "-f", "lavfi", "-i", "anoisesrc=c=pink:r=48000:a=0.02:d=4"])
            .args(["-filter_complex", "[0]volume=0.3,volume='if(lt(mod(t,2),1),1,0)':eval=frame[s];[s][1]amix=inputs=2:normalize=0,aformat=channel_layouts=mono[o]"])
            .args(["-map", "[o]", "-c:a", "pcm_s16le"])
            .arg(&mic)
            .status()
            .unwrap();
        assert!(st.success());
        let before = std::fs::read(&mic).unwrap();
        assert_eq!(ensure_clean(&ffmpeg, &dir, "mic.wav", None).unwrap(), CLEAN_REL);
        assert_eq!(std::fs::read(&mic).unwrap(), before, "mic.wav untouched");
        assert!(is_fresh(&dir, &mic, FFT_FILTER));
        let n_in = crate::wav::wav_duration_us(&mic).unwrap();
        let n_out = crate::wav::wav_duration_us(&clean_path(&dir)).unwrap();
        assert_eq!(n_in, n_out, "same length");
        let mean = |file: &Path, from: &str, to: &str| -> f64 {
            let out = command(&ffmpeg)
                .args(["-hide_banner", "-i"])
                .arg(file)
                .args(["-af", &format!("atrim={from}:{to},volumedetect"), "-f", "null", "-"])
                .output()
                .unwrap();
            let e = String::from_utf8_lossy(&out.stderr);
            e.lines().find_map(|l| l.split("mean_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap()
        };
        let clean = clean_path(&dir);
        let (tone_in, tone_out) = (mean(&mic, "0.3", "0.9"), mean(&clean, "0.3", "0.9"));
        let (gap_in, gap_out) = (mean(&mic, "3.2", "3.8"), mean(&clean, "3.2", "3.8"));
        assert!((tone_in - tone_out).abs() < 1.0, "tone holds: {tone_in} -> {tone_out}");
        assert!(gap_out < gap_in - 4.0, "noise drops: {gap_in} -> {gap_out}");
        // A second call finds the fresh copy and does nothing.
        let t = std::fs::metadata(&clean).unwrap().modified().unwrap();
        ensure_clean(&ffmpeg, &dir, "mic.wav", None).unwrap();
        assert_eq!(std::fs::metadata(&clean).unwrap().modified().unwrap(), t);
    }
}
