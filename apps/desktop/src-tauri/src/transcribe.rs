//! Transcription commands: `transcript.json` from `mic.wav` through the whisper.cpp sidecar
//! (`marz-transcribe`), the model status and the model download (only after he says yes in the UI).

use crate::projects::{Allowed, checked};
use marz_transcribe::models::{self, REQUIRED_MODELS};
use marz_transcribe::{TranscribeError, model_status as status_of, run_transcription, transcript_is_current};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Cancels a running transcription between sections.
#[derive(Default)]
pub struct TranscribeRun(AtomicBool);

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum TranscribeFailure {
    NoWhisper,
    NoModel,
    NoMic,
    Failed(String),
    Cancelled,
}

impl From<TranscribeError> for TranscribeFailure {
    fn from(e: TranscribeError) -> Self {
        match e {
            TranscribeError::NoWhisper => Self::NoWhisper,
            TranscribeError::NoModel => Self::NoModel,
            TranscribeError::NoMic => Self::NoMic,
            TranscribeError::Failed(s) => Self::Failed(s),
            TranscribeError::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    pct: f32,
}

fn app_data(app: &AppHandle) -> Result<PathBuf, TranscribeFailure> {
    app.path().app_data_dir().map_err(|e| TranscribeFailure::Failed(e.to_string()))
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// The mic track's file and offset from `project.json` (None: the project has no mic).
pub fn mic_track(project_json: &str) -> Option<(String, i64)> {
    let v: Value = serde_json::from_str(project_json).ok()?;
    let mic = v.get("tracks")?.get("mic")?;
    Some((mic.get("file")?.as_str()?.to_string(), mic.get("offsetUs")?.as_i64().unwrap_or(0)))
}

#[tauri::command(async)]
pub fn transcribe(app: AppHandle, allowed: State<'_, Allowed>, run: State<'_, TranscribeRun>, project_dir: String) -> Result<(), TranscribeFailure> {
    let dir = checked(&allowed, &project_dir).map_err(TranscribeFailure::Failed)?;
    let text = std::fs::read_to_string(dir.join("project.json")).map_err(|e| TranscribeFailure::Failed(e.to_string()))?;
    let (file, offset_us) = mic_track(&text).ok_or(TranscribeFailure::NoMic)?;
    if file != "mic.wav" {
        return Err(TranscribeFailure::Failed(format!("unexpected mic file {file}")));
    }
    let mic = dir.join(&file);
    if !mic.is_file() {
        return Err(TranscribeFailure::NoMic);
    }
    if transcript_is_current(&dir, &mic) {
        let _ = app.emit("transcribe://progress", Progress { pct: 1.0 });
        return Ok(());
    }
    let data = app_data(&app)?;
    let whisper = marz_transcribe::find_whisper(exe_dir().as_deref(), Some(&data)).ok_or(TranscribeFailure::NoWhisper)?;
    if !REQUIRED_MODELS.iter().all(|m| models::model_ok(&data, m)) {
        return Err(TranscribeFailure::NoModel);
    }
    let model = models::model_path(&data, &models::MAIN_MODEL);
    let vad = models::model_path(&data, &models::VAD_MODEL);
    let ffmpeg = marz_export::tools::find_ffmpeg().map_err(|_| TranscribeFailure::Failed("FFmpeg is missing".into()))?;
    run.0.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    let mut progress = move |pct: f32| {
        let _ = app2.emit("transcribe://progress", Progress { pct });
    };
    run_transcription(&dir, offset_us, &whisper, &model, Some(&vad), &ffmpeg, &std::env::temp_dir(), &mut progress, &run.0)
        .map(|_| ())
        .map_err(TranscribeFailure::from)
}

#[tauri::command]
pub fn transcribe_cancel(run: State<'_, TranscribeRun>) {
    run.0.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn model_status(app: AppHandle) -> Result<models::ModelStatus, TranscribeFailure> {
    Ok(status_of(&app_data(&app)?))
}

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Downloads the missing model files with Windows' own `curl.exe` (no HTTP crate), each to a
/// `.part` file renamed only when its size is right. Progress is the share of all bytes.
#[tauri::command(async)]
pub fn download_model(app: AppHandle) -> Result<(), TranscribeFailure> {
    let data = app_data(&app)?;
    let dir = models::model_dir(&data);
    std::fs::create_dir_all(&dir).map_err(|e| TranscribeFailure::Failed(e.to_string()))?;
    let total: u64 = REQUIRED_MODELS.iter().map(|m| m.bytes).sum();
    let mut done: u64 = REQUIRED_MODELS.iter().filter(|m| models::model_ok(&data, m)).map(|m| m.bytes).sum();
    for m in REQUIRED_MODELS.iter().filter(|m| !models::model_ok(&data, m)) {
        let dest = models::model_path(&data, m);
        let part = dest.with_extension("part");
        let _ = std::fs::remove_file(&part);
        let mut child = command("curl.exe")
            .args(models::download_args(m.url, &part))
            .spawn()
            .map_err(|e| TranscribeFailure::Failed(format!("curl.exe did not start: {e}")))?;
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| TranscribeFailure::Failed(e.to_string()))? {
                break s;
            }
            let got = std::fs::metadata(&part).map(|md| md.len()).unwrap_or(0);
            let _ = app.emit("model://progress", Progress { pct: (done + got.min(m.bytes)) as f32 / total as f32 });
            std::thread::sleep(Duration::from_millis(300));
        };
        let size = std::fs::metadata(&part).map(|md| md.len()).unwrap_or(0);
        if !status.success() || size != m.bytes {
            let _ = std::fs::remove_file(&part);
            return Err(TranscribeFailure::Failed(format!("{} did not download ({size} of {} bytes)", m.name, m.bytes)));
        }
        std::fs::rename(&part, &dest).map_err(|e| TranscribeFailure::Failed(e.to_string()))?;
        done += m.bytes;
    }
    let _ = app.emit("model://progress", Progress { pct: 1.0 });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_mic_track() {
        let p = r#"{"tracks":{"screen":{"file":"screen.mp4","offsetUs":0},"mic":{"file":"mic.wav","offsetUs":4286,"volume":1,"muted":false}}}"#;
        assert_eq!(mic_track(p), Some(("mic.wav".into(), 4286)));
        assert_eq!(mic_track(r#"{"tracks":{"screen":{"file":"screen.mp4","offsetUs":0}}}"#), None);
    }

    #[test]
    fn failures_serialize_as_kind_and_detail() {
        assert_eq!(serde_json::to_string(&TranscribeFailure::NoWhisper).unwrap(), r#"{"kind":"noWhisper"}"#);
        assert_eq!(serde_json::to_string(&TranscribeFailure::from(TranscribeError::Failed("x".into()))).unwrap(), r#"{"kind":"failed","detail":"x"}"#);
    }
}
