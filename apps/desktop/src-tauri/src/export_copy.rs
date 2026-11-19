//! "Also copy to": after a good export, the MP4, its `.srt` and `.vtt`, and a small JSON sidecar are
//! copied into one remembered folder (the MarzOS drop folder). No network calls.
//!
//! The page never names the folder: it is picked in a native dialog here and saved in the app config
//! folder (`export-settings.json`). Only MP4s this app just exported are copied.

use crate::export::Exports;
use crate::projects::{self, Allowed};
use marz_capture::project::iso_utc_now;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const SETTINGS_FILE: &str = "export-settings.json";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// What the page knows about the export, for the sidecar.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportMeta {
    pub title: String,
    pub duration_us: i64,
    pub preset: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// What was copied, file names in the destination folder.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub dir: String,
    pub files: Vec<String>,
}

/// The sidecar JSON. `captions` is null when no `.srt`/`.vtt` was written.
pub fn sidecar(meta: &ExportMeta, video: &str, srt: Option<&str>, vtt: Option<&str>, at: &str) -> Value {
    let captions = if srt.is_none() && vtt.is_none() { Value::Null } else { json!({ "srt": srt, "vtt": vtt }) };
    json!({
        "title": meta.title,
        "lengthSec": (meta.duration_us.max(0) as f64 / 1e3).round() / 1e3,
        "durationUs": meta.duration_us.max(0),
        "preset": meta.preset,
        "codec": meta.codec,
        "width": meta.width,
        "height": meta.height,
        "fps": meta.fps,
        "video": video,
        "captions": captions,
        "exportedAt": at,
        "app": "Marz Recorder",
    })
}

fn check_meta(meta: &ExportMeta) -> Result<(), String> {
    if !matches!(meta.preset.as_str(), "youtube" | "vertical") || !matches!(meta.codec.as_str(), "h264" | "hevc") {
        return Err("Unknown preset or codec".into());
    }
    Ok(())
}

/// Copy `src` to `dst` through `<dst>.part` and a rename (a watcher never sees half a file).
fn copy_atomic(src: &Path, dst: &Path) -> Result<(), String> {
    if same_file(src, dst) {
        return Ok(());
    }
    let part = PathBuf::from(format!("{}.part", dst.to_string_lossy()));
    fs::copy(src, &part).map_err(|e| format!("{}: {e}", src.display()))?;
    if dst.exists() {
        let _ = fs::remove_file(dst);
    }
    fs::rename(&part, dst).map_err(|e| {
        let _ = fs::remove_file(&part);
        format!("{}: {e}", dst.display())
    })
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn write_atomic(dst: &Path, text: &str) -> Result<(), String> {
    let part = PathBuf::from(format!("{}.part", dst.to_string_lossy()));
    fs::write(&part, text).map_err(err)?;
    fs::rename(&part, dst).map_err(|e| {
        let _ = fs::remove_file(&part);
        err(e)
    })
}

/// Copy the export `mp4` (and the `.srt`/`.vtt` beside it, when there) into `dest`, then write
/// `<name>.json` last. Returns the file names written in `dest`.
pub fn copy_export(mp4: &Path, dest: &Path, meta: &ExportMeta, at: &str) -> Result<Vec<String>, String> {
    check_meta(meta)?;
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let video = name(mp4);
    if video.is_empty() || !mp4.is_file() {
        return Err("The exported file is missing".into());
    }
    let mut files = Vec::new();
    copy_atomic(mp4, &dest.join(&video))?;
    files.push(video.clone());
    let mut side = |ext: &str| -> Result<Option<String>, String> {
        let src = mp4.with_extension(ext);
        if !src.is_file() {
            return Ok(None);
        }
        let n = name(&src);
        copy_atomic(&src, &dest.join(&n))?;
        files.push(n.clone());
        Ok(Some(n))
    };
    let srt = side("srt")?;
    let vtt = side("vtt")?;
    let json_name = name(&mp4.with_extension("json"));
    let text = serde_json::to_string_pretty(&sidecar(meta, &video, srt.as_deref(), vtt.as_deref(), at)).map_err(err)?;
    write_atomic(&dest.join(&json_name), &text)?;
    files.push(json_name);
    Ok(files)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(SETTINGS_FILE))
}

/// The remembered folder from the settings text (None when unset or empty).
pub fn parse_copy_to(text: &str) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(text).ok()?;
    v["copyTo"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
}

fn saved_copy_to(app: &AppHandle) -> Option<PathBuf> {
    parse_copy_to(&fs::read_to_string(settings_path(app).ok()?).ok()?)
}

fn save_copy_to(app: &AppHandle, dest: Option<&Path>) -> Result<(), String> {
    let text = json!({ "copyTo": dest.map(|d| d.to_string_lossy().into_owned()) }).to_string();
    fs::write(settings_path(app)?, text).map_err(err)
}

/// The remembered "Also copy to" folder, or None.
#[tauri::command(async)]
pub fn export_copy_settings(app: AppHandle) -> Option<String> {
    saved_copy_to(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Folder dialog for "Also copy to". Saved for next time. None when cancelled.
#[tauri::command(async)]
pub fn pick_export_copy_dest(app: AppHandle, window: WebviewWindow, allowed: State<'_, Allowed>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Pick the folder to copy exports to").set_parent(&window);
    if let Some(start) = saved_copy_to(&app) {
        dialog = dialog.set_directory(start);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(None) };
    let dir = picked.into_path().map_err(err)?;
    let allowed_dirs = allowed.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if projects::is_project_folder(&dir) || crate::export::inside_project(&dir.join("x.mp4"), &allowed_dirs) {
        return Err("Pick a folder outside the project.".into());
    }
    save_copy_to(&app, Some(&dir))?;
    Ok(Some(dir.to_string_lossy().into_owned()))
}

/// Stop copying exports.
#[tauri::command(async)]
pub fn clear_export_copy_dest(app: AppHandle) -> Result<(), String> {
    save_copy_to(&app, None)
}

/// Copy a finished export into the remembered folder. Only MP4s this app just exported.
#[tauri::command(async)]
pub fn export_copy_to(app: AppHandle, exports: State<'_, Exports>, out_path: String, meta: ExportMeta) -> Result<CopyReport, String> {
    let mp4 = PathBuf::from(&out_path);
    if !exports.is_done(&mp4) {
        return Err("This file was not exported here".into());
    }
    let dest = saved_copy_to(&app).ok_or("No folder to copy to")?;
    let files = copy_export(&mp4, &dest, &meta, &iso_utc_now())?;
    Ok(CopyReport { dir: dest.to_string_lossy().into_owned(), files })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-copy-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn meta() -> ExportMeta {
        ExportMeta { title: "Demo".into(), duration_us: 62_400_500, preset: "youtube".into(), codec: "hevc".into(), width: 2560, height: 1440, fps: 60 }
    }

    #[test]
    fn copies_the_mp4_captions_and_writes_the_sidecar_last() {
        let root = temp_dir("full");
        let out = root.join("Exports");
        let dest = root.join("MarzOS");
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let mp4 = out.join("Demo YouTube.mp4");
        fs::write(&mp4, b"video").unwrap();
        fs::write(out.join("Demo YouTube.srt"), b"1\n").unwrap();
        fs::write(out.join("Demo YouTube.vtt"), b"WEBVTT\n").unwrap();
        let files = copy_export(&mp4, &dest, &meta(), "2026-11-19T18:02:11Z").unwrap();
        assert_eq!(files, ["Demo YouTube.mp4", "Demo YouTube.srt", "Demo YouTube.vtt", "Demo YouTube.json"]);
        assert_eq!(fs::read(dest.join("Demo YouTube.mp4")).unwrap(), b"video");
        assert_eq!(fs::read(dest.join("Demo YouTube.vtt")).unwrap(), b"WEBVTT\n");
        let v: Value = serde_json::from_str(&fs::read_to_string(dest.join("Demo YouTube.json")).unwrap()).unwrap();
        assert_eq!(v["title"], "Demo");
        assert_eq!(v["lengthSec"], 62.401);
        assert_eq!(v["preset"], "youtube");
        assert_eq!(v["codec"], "hevc");
        assert_eq!(v["width"], 2560);
        assert_eq!(v["video"], "Demo YouTube.mp4");
        assert_eq!(v["captions"]["srt"], "Demo YouTube.srt");
        assert_eq!(v["captions"]["vtt"], "Demo YouTube.vtt");
        assert_eq!(v["exportedAt"], "2026-11-19T18:02:11Z");
        let leftovers: Vec<_> = fs::read_dir(&dest).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".part")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn without_captions_the_sidecar_says_null_and_an_old_copy_is_replaced() {
        let root = temp_dir("nocap");
        let dest = root.join("drop");
        fs::create_dir_all(&dest).unwrap();
        let mp4 = root.join("Demo Vertical.mp4");
        fs::write(&mp4, b"new").unwrap();
        fs::write(dest.join("Demo Vertical.mp4"), b"old").unwrap();
        let m = ExportMeta { preset: "vertical".into(), codec: "h264".into(), ..meta() };
        let files = copy_export(&mp4, &dest, &m, "t").unwrap();
        assert_eq!(files, ["Demo Vertical.mp4", "Demo Vertical.json"]);
        assert_eq!(fs::read(dest.join("Demo Vertical.mp4")).unwrap(), b"new");
        let v: Value = serde_json::from_str(&fs::read_to_string(dest.join("Demo Vertical.json")).unwrap()).unwrap();
        assert!(v["captions"].is_null());
    }

    #[test]
    fn copying_into_the_export_folder_itself_only_adds_the_sidecar() {
        let root = temp_dir("same");
        let mp4 = root.join("Demo YouTube.mp4");
        fs::write(&mp4, b"video").unwrap();
        let files = copy_export(&mp4, &root, &meta(), "t").unwrap();
        assert_eq!(files.last().unwrap(), "Demo YouTube.json");
        assert_eq!(fs::read(&mp4).unwrap(), b"video");
    }

    #[test]
    fn refuses_a_missing_folder_file_or_unknown_preset() {
        let root = temp_dir("bad");
        let mp4 = root.join("a.mp4");
        assert!(copy_export(&mp4, &root, &meta(), "t").is_err());
        fs::write(&mp4, b"v").unwrap();
        assert!(copy_export(&mp4, &root.join("nope"), &meta(), "t").is_err());
        let m = ExportMeta { preset: "../x".into(), ..meta() };
        assert!(copy_export(&mp4, &root, &m, "t").is_err());
    }

    #[test]
    fn settings_read_the_folder_or_nothing() {
        assert_eq!(parse_copy_to(r#"{"copyTo":"D:\\MarzOS"}"#), Some(PathBuf::from("D:\\MarzOS")));
        assert_eq!(parse_copy_to(r#"{"copyTo":null}"#), None);
        assert_eq!(parse_copy_to(r#"{"copyTo":""}"#), None);
        assert_eq!(parse_copy_to("garbage"), None);
    }
}
