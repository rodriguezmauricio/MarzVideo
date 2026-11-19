//! Mic noise removal: makes the cleaned copy `cache/mic.clean.wav` (see `marz_export::clean`) that the
//! preview plays and the export reads. `mic.wav` is never touched.

use crate::projects::{Allowed, checked};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// One cleaning at a time (opening a project and starting an export can both ask for it).
#[derive(Default)]
pub struct Cleaning(Mutex<()>);

/// Make the cleaned mic copy unless a fresh one exists; returns its path relative to the project
/// (`cache/mic.clean.wav`). An RNNoise model `rnnoise.rnnn` in the app data `models` folder is used
/// when present, else FFmpeg's FFT denoiser.
#[tauri::command(async)]
pub fn audio_clean_mic(app: AppHandle, allowed: State<'_, Allowed>, cleaning: State<'_, Cleaning>, project_dir: String, mic_file: String) -> Result<String, String> {
    let dir = checked(&allowed, &project_dir)?;
    if mic_file != "mic.wav" {
        return Err(format!("unexpected mic file {mic_file}"));
    }
    let ffmpeg = marz_export::tools::find_ffmpeg().map_err(|_| "FFmpeg is missing".to_string())?;
    let models = app.path().app_data_dir().ok().map(|d| d.join("models"));
    let _one = cleaning.0.lock().unwrap_or_else(|e| e.into_inner());
    marz_export::clean::ensure_clean(&ffmpeg, &dir, &mic_file, models.as_deref())
}
