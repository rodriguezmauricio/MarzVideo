//! Settings: the one place that reads and writes the settings stored in files (design
//! `docs/superpowers/specs/2026-11-19-onboarding-settings-design.md`).
//!
//! - `settings.json` in the app config folder: projects folder, exports folder, rebound hotkeys,
//!   onboarding seen. Unknown keys are kept on write.
//! - The archive folder stays in `archive-settings.json` (`archive.rs` reads and writes it).
//! - Whisper, the models and Claude Code are found on disk, as the AI pass finds them.
//!
//! The settings in the webview's localStorage (default mic, camera, export preset...) are read and
//! written by `src/settings/localSettings.ts`.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use marz_capture::hotkeys;

const FILE: &str = "settings.json";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// What `settings.json` holds. Missing keys are defaults.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exports_dir: Option<String>,
    /// Only the rebound hotkeys: action id to combo ("recordStop": "Ctrl+Alt+R").
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hotkeys: BTreeMap<String, String>,
    #[serde(default)]
    pub onboarding_done: bool,
    /// The AI provider (`provider.rs`). Never the API key: that is in Credential Manager.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<crate::provider::AiConfig>,
    /// Keys a later build wrote: kept as they are.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

/// The stored settings, or the defaults when the file is missing or unreadable.
pub fn read(path: &Path) -> Stored {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Write the settings (temp file, then rename, so a crash never leaves half a file).
pub fn write(path: &Path, s: &Stored) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(s).map_err(io::Error::other)?)?;
    fs::rename(&tmp, path)
}

/// Serializes read-modify-write of `settings.json`.
static WRITE: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join(FILE))
}

pub(crate) fn load(app: &AppHandle) -> Stored {
    path(app).map(|p| read(&p)).unwrap_or_default()
}

pub(crate) fn update(app: &AppHandle, f: impl FnOnce(&mut Stored)) -> Result<Stored, String> {
    let _g = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let p = path(app)?;
    let mut s = read(&p);
    f(&mut s);
    write(&p, &s).map_err(err)?;
    Ok(s)
}

/// `%USERPROFILE%\Videos\Marz Recorder`.
fn default_projects(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().video_dir().map_err(err)?.join("Marz Recorder"))
}

/// The folder a chosen path resolves to, or the default when none is set.
pub fn pick_root(chosen: Option<&str>, default: PathBuf) -> PathBuf {
    chosen.filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or(default)
}

/// Where recordings go and where Home looks: the chosen folder or `Videos\Marz Recorder`.
pub(crate) fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(pick_root(load(app).projects_dir.as_deref(), default_projects(app)?))
}

/// Where the export save dialog starts: the chosen folder or `<projects folder>\Exports`.
pub(crate) fn exports_root(app: &AppHandle) -> Result<PathBuf, String> {
    let s = load(app);
    let projects = pick_root(s.projects_dir.as_deref(), default_projects(app)?);
    Ok(pick_root(s.exports_dir.as_deref(), projects.join("Exports")))
}

/// At start: use the rebound hotkeys. A file with bad combos falls back to the defaults.
pub fn apply_stored_hotkeys(app: &AppHandle) {
    if hotkeys::set_overrides(&load(app).hotkeys).is_err() {
        let _ = hotkeys::set_overrides(&BTreeMap::new());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    projects_dir: String,
    projects_default: bool,
    exports_dir: String,
    exports_default: bool,
    archive_dir: Option<String>,
    archive_suggested: Option<String>,
    /// Every action id with its combo in force.
    hotkeys: BTreeMap<String, String>,
    onboarding_done: bool,
}

fn view(app: &AppHandle) -> Result<View, String> {
    let s = load(app);
    let a = crate::archive::archive_settings(app.clone());
    Ok(View {
        projects_dir: projects_root(app)?.to_string_lossy().into_owned(),
        projects_default: s.projects_dir.is_none(),
        exports_dir: exports_root(app)?.to_string_lossy().into_owned(),
        exports_default: s.exports_dir.is_none(),
        archive_dir: a.dest,
        archive_suggested: a.suggested,
        hotkeys: hotkeys::labels(),
        onboarding_done: s.onboarding_done,
    })
}

#[tauri::command(async)]
pub fn settings_get(app: AppHandle) -> Result<View, String> {
    view(&app)
}

/// Folder dialog for "projects", "exports" or "archive". None when cancelled.
#[tauri::command(async)]
pub fn settings_pick_folder(app: AppHandle, window: WebviewWindow, kind: String) -> Result<Option<View>, String> {
    if kind == "archive" {
        return Ok(crate::archive::pick_archive_dest(app.clone(), window)?.map(|_| view(&app)).transpose()?);
    }
    let start = match kind.as_str() {
        "projects" => projects_root(&app)?,
        "exports" => exports_root(&app)?,
        _ => return Err(format!("Unknown folder {kind}.")),
    };
    let title = if kind == "projects" { "Pick the projects folder" } else { "Pick the exports folder" };
    let mut dialog = app.dialog().file().set_title(title).set_parent(&window);
    if start.is_dir() {
        dialog = dialog.set_directory(&start);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(None) };
    let dir = picked.into_path().map_err(err)?;
    if crate::projects::is_project_folder(&dir) {
        return Err("Pick a folder that is not a project.".into());
    }
    let text = dir.to_string_lossy().into_owned();
    update(&app, |s| {
        if kind == "projects" {
            s.projects_dir = Some(text);
        } else {
            s.exports_dir = Some(text);
        }
    })?;
    Ok(Some(view(&app)?))
}

/// Back to the default projects or exports folder.
#[tauri::command(async)]
pub fn settings_reset_folder(app: AppHandle, kind: String) -> Result<View, String> {
    update(&app, |s| match kind.as_str() {
        "projects" => s.projects_dir = None,
        "exports" => s.exports_dir = None,
        _ => {}
    })?;
    view(&app)
}

#[tauri::command(async)]
pub fn settings_use_drive(app: AppHandle) -> Result<View, String> {
    crate::archive::use_suggested_dest(app.clone())?;
    view(&app)
}

/// Save the rebound hotkeys (action id to combo; defaults are left out) and use them from the next
/// time the recorder opens. Refused with the first problem's sentence when a combo is not allowed.
#[tauri::command(async)]
pub fn settings_set_hotkeys(app: AppHandle, overrides: BTreeMap<String, String>) -> Result<View, String> {
    let kept = only_rebound(&overrides);
    hotkeys::set_overrides(&kept).map_err(|p| p.into_iter().next().map(|(_, why)| why).unwrap_or_default())?;
    update(&app, |s| s.hotkeys = kept)?;
    // Every window (Home, the recorder bars) shows the new names at once.
    let _ = app.emit("settings://hotkeys", hotkeys::labels());
    view(&app)
}

/// The overrides without the ones equal to their default, so `settings.json` holds only changes.
pub fn only_rebound(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    overrides
        .iter()
        .filter(|(id, text)| {
            let parsed = hotkeys::Combo::parse(text);
            parsed.is_none() || hotkeys::default_combo(id).is_none_or(|d| Some(d) != parsed)
        })
        .map(|(a, b)| (a.clone(), b.clone()))
        .collect()
}

#[tauri::command(async)]
pub fn settings_set_onboarding(app: AppHandle, done: bool) -> Result<(), String> {
    update(&app, |s| s.onboarding_done = done).map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    whisper: Option<String>,
    model_present: bool,
    model_name: String,
    model_bytes: u64,
    claude: Option<String>,
    /// `<app data>\whisper`: where whisper-cli.exe can go.
    whisper_dir: Option<String>,
}

#[tauri::command(async)]
pub fn ai_status(app: AppHandle) -> AiStatus {
    let data = app.path().app_data_dir().ok();
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let whisper = marz_transcribe::find_whisper(exe_dir.as_deref(), data.as_deref());
    let models = data.as_deref().map(marz_transcribe::models::model_status);
    AiStatus {
        whisper: whisper.map(|p| p.to_string_lossy().into_owned()),
        model_present: models.as_ref().is_some_and(|m| m.present),
        model_name: models.as_ref().map(|m| m.name.clone()).unwrap_or_default(),
        model_bytes: models.as_ref().map_or(0, |m| m.bytes),
        claude: crate::ai::find_claude().map(|p| p.to_string_lossy().into_owned()),
        whisper_dir: data.map(|d| d.join("whisper").to_string_lossy().into_owned()),
    }
}

#[derive(Serialize)]
pub struct Devices {
    mics: Vec<crate::recorder::Mic>,
    cameras: Vec<crate::recorder::Camera>,
}

#[tauri::command(async)]
pub fn settings_devices() -> Devices {
    Devices { mics: crate::recorder::list_mics(), cameras: crate::recorder::list_cameras() }
}

/// The level meter for Settings and onboarding: `settings://level` (0..1) to the main window
/// every 50 ms while on. Its own run, so it never touches the recorder bar's meter.
#[derive(Default)]
pub struct SettingsMeter(Mutex<Option<meter::Run>>);

#[tauri::command(async)]
pub fn settings_meter(app: AppHandle, state: tauri::State<'_, SettingsMeter>, on: bool, mic_id: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(run) = slot.take() {
        run.stop();
    }
    if on {
        *slot = Some(meter::start(app, mic_id)?);
    }
    Ok(())
}

mod meter {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;

    pub struct Run {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Run {
        pub fn stop(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    #[cfg(windows)]
    pub fn start(app: tauri::AppHandle, mic_id: Option<String>) -> Result<Run, String> {
        use tauri::Emitter;
        let handle = marz_capture::win::mic::start_meter(mic_id.as_deref()).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("marz-settings-meter".into())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    let level = if handle.lost() { 0.0 } else { handle.level() };
                    let _ = app.emit_to("main", "settings://level", level);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                handle.stop();
            })
            .map_err(|e| e.to_string())?;
        Ok(Run { stop, thread: Some(thread) })
    }

    #[cfg(not(windows))]
    pub fn start(_app: tauri::AppHandle, _mic_id: Option<String>) -> Result<Run, String> {
        Err("The meter needs Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marz-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_or_broken_file_reads_as_defaults() {
        let d = tmp("missing");
        assert_eq!(read(&d.join(FILE)), Stored::default());
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE), "{not json").unwrap();
        assert_eq!(read(&d.join(FILE)), Stored::default());
    }

    #[test]
    fn round_trips_and_keeps_unknown_keys() {
        let d = tmp("roundtrip");
        let p = d.join(FILE);
        fs::create_dir_all(&d).unwrap();
        fs::write(&p, r#"{"projectsDir":"D:\\Takes","later":{"x":1},"onboardingDone":true}"#).unwrap();
        let mut s = read(&p);
        assert_eq!(s.projects_dir.as_deref(), Some("D:\\Takes"));
        assert!(s.onboarding_done);
        s.hotkeys.insert("pause".into(), "Ctrl+Alt+P".into());
        write(&p, &s).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["later"]["x"], 1);
        assert_eq!(v["hotkeys"]["pause"], "Ctrl+Alt+P");
        assert!(v.get("exportsDir").is_none());
        assert!(!d.join("settings.json.tmp").exists());
    }

    #[test]
    fn roots_fall_back_to_the_defaults() {
        assert_eq!(pick_root(None, PathBuf::from("V")), PathBuf::from("V"));
        assert_eq!(pick_root(Some(""), PathBuf::from("V")), PathBuf::from("V"));
        assert_eq!(pick_root(Some("D:\\Takes"), PathBuf::from("V")), PathBuf::from("D:\\Takes"));
    }

    #[test]
    fn only_rebound_keys_are_stored() {
        let m: BTreeMap<String, String> = [("pause", "ctrl+shift+p"), ("mute", "Ctrl+Alt+M")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let kept = only_rebound(&m);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept["mute"], "Ctrl+Alt+M");
    }
}
