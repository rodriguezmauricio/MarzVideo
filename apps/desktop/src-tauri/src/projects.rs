//! The projects folder and project files, as Tauri commands for Home and the editor.
//!
//! The page never names a folder on its own: a command only touches a folder that this module
//! listed from the projects folder or that the person picked in the folder dialog (`Allowed`).

use marz_capture::recover::{needs_recovery, recover, screen_duration_us};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const PROJECT_JSON: &str = "project.json";
const CRASH_MARKER: &str = marz_capture::project::CRASH_MARKER;
/// Files the editor may read. Raw media is loaded through the asset protocol, not this.
const READABLE: [&str; 2] = [PROJECT_JSON, "events.jsonl"];

/// Folders the page may touch: listed from the projects folder or picked in the dialog.
#[derive(Default)]
pub struct Allowed(Mutex<HashSet<PathBuf>>);

/// One `.marz` folder for Home. `edited_at` is ms since the epoch.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ProjectRow {
    pub dir: String,
    pub name: String,
    pub duration_us: i64,
    pub zooms: usize,
    pub cuts: usize,
    pub edited_at: u64,
    pub needs_recovery: bool,
}

/// What the folder dialog gave back.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Picked {
    Cancelled,
    NotProject,
    Project { dir: String, needs_recovery: bool },
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn has_marz_suffix(dir: &Path) -> bool {
    dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_ascii_lowercase().ends_with(".marz"))
}

/// A real folder: not a file, and not a symlink or junction (those are never followed).
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

/// A folder is a project when its name ends in `.marz` or it holds a `project.json`.
pub fn is_project_folder(dir: &Path) -> bool {
    is_real_dir(dir) && (has_marz_suffix(dir) || dir.join(PROJECT_JSON).is_file())
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn folder_name(dir: &Path) -> String {
    let n = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Untitled");
    n.strip_suffix(".marz").unwrap_or(n).to_string()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The Home row for one folder, or None when it is neither a project nor a killed recording.
/// `ffprobe` measures how much of a killed recording's video is safe (0 without it).
pub fn project_row(dir: &Path, ffprobe: Option<&Path>) -> Option<ProjectRow> {
    let dir_s = dir.to_string_lossy().into_owned();
    if needs_recovery(dir) {
        let marker = read_json(&dir.join(CRASH_MARKER));
        let name = marker.as_ref().and_then(|m| m["name"].as_str()).map_or_else(|| folder_name(dir), str::to_string);
        let fps = marker.as_ref().and_then(|m| m["fps"].as_u64()).unwrap_or(60) as u32;
        let duration_us = ffprobe.and_then(|p| screen_duration_us(p, &dir.join("screen.mp4"), fps).ok()).unwrap_or(0);
        return Some(ProjectRow {
            dir: dir_s,
            name,
            duration_us,
            zooms: 0,
            cuts: 0,
            edited_at: mtime_ms(&dir.join(CRASH_MARKER)),
            needs_recovery: true,
        });
    }
    let file = dir.join(PROJECT_JSON);
    if !file.is_file() {
        return None;
    }
    // An unreadable project.json still gets a row: opening it shows the editor's error.
    let doc = read_json(&file).unwrap_or(Value::Null);
    let len = |key: &str| doc["edits"][key].as_array().map_or(0, Vec::len);
    Some(ProjectRow {
        dir: dir_s,
        name: doc["name"].as_str().map_or_else(|| folder_name(dir), str::to_string),
        duration_us: doc["durationUs"].as_i64().unwrap_or(0),
        zooms: len("zooms"),
        cuts: len("cuts"),
        edited_at: mtime_ms(&file),
        needs_recovery: false,
    })
}

/// Every `*.marz` folder directly in `root`, newest first.
pub fn scan(root: &Path, ffprobe: Option<&Path>) -> io::Result<Vec<ProjectRow>> {
    let mut rows: Vec<ProjectRow> = fs::read_dir(root)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| is_real_dir(p) && has_marz_suffix(p))
        .filter_map(|p| project_row(&p, ffprobe))
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.edited_at));
    Ok(rows)
}

/// The path of a file the editor may read inside `dir`, or an error for anything else.
pub fn readable_path(dir: &Path, path: &str) -> Result<PathBuf, String> {
    if READABLE.contains(&path) { Ok(dir.join(path)) } else { Err(format!("{path} cannot be read here")) }
}

/// One save at a time: every save goes through the same `project.json.tmp`, so two saves at once
/// (a debounced autosave and a flush on leaving) would truncate each other's temp file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Write `project.json` through `project.json.tmp` and a rename, so a crash or power cut never
/// leaves a half-written file under the real name. Nothing else in the folder is writable.
/// Saves are serialized, and a failed save removes its temp file.
pub fn write_project_json_atomic(dir: &Path, text: &str) -> io::Result<()> {
    serde_json::from_str::<Value>(text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = dir.join("project.json.tmp");
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, dir.join(PROJECT_JSON))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `%USERPROFILE%\Videos\Marz Recorder`, created on first use.
fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().video_dir().map_err(err)?.join("Marz Recorder");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Let the page load files from `dir` (asset protocol) and call the commands below on it.
fn allow_dir(app: &AppHandle, allowed: &Allowed, dir: &Path) -> Result<(), String> {
    app.asset_protocol_scope().allow_directory(dir, true).map_err(err)?;
    allowed.0.lock().map_err(err)?.insert(dir.to_path_buf());
    Ok(())
}

fn checked(allowed: &Allowed, dir: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(dir);
    if allowed.0.lock().map_err(err)?.contains(&dir) { Ok(dir) } else { Err("This folder was not opened from Home.".into()) }
}

#[tauri::command]
pub fn projects_dir(app: AppHandle) -> Result<String, String> {
    Ok(default_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn list_projects(app: AppHandle, allowed: State<'_, Allowed>) -> Result<Vec<ProjectRow>, String> {
    let root = default_dir(&app)?;
    let ffprobe = marz_capture::ffmpeg::find_ffprobe().ok();
    let rows = scan(&root, ffprobe.as_deref()).map_err(err)?;
    for row in &rows {
        allow_dir(&app, &allowed, Path::new(&row.dir))?;
    }
    Ok(rows)
}

/// Folder dialog for "Open a project". Runs here, not in the page, so the page never hands over a path.
#[tauri::command(async)]
pub fn pick_project(app: AppHandle, window: WebviewWindow, allowed: State<'_, Allowed>) -> Result<Picked, String> {
    let mut dialog = app.dialog().file().set_title("Open a project").set_parent(&window);
    if let Ok(root) = default_dir(&app) {
        dialog = dialog.set_directory(root);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(Picked::Cancelled) };
    let dir = picked.into_path().map_err(err)?;
    if !is_project_folder(&dir) {
        return Ok(Picked::NotProject);
    }
    allow_dir(&app, &allowed, &dir)?;
    Ok(Picked::Project { needs_recovery: needs_recovery(&dir), dir: dir.to_string_lossy().into_owned() })
}

#[tauri::command(async)]
pub fn read_text(allowed: State<'_, Allowed>, dir: String, path: String) -> Result<String, String> {
    let file = readable_path(&checked(&allowed, &dir)?, &path)?;
    fs::read_to_string(file).map_err(err)
}

#[tauri::command(async)]
pub fn write_project_json(allowed: State<'_, Allowed>, dir: String, text: String) -> Result<(), String> {
    write_project_json_atomic(&checked(&allowed, &dir)?, &text).map_err(err)
}

/// Rebuild `project.json` for a killed recording. Returns the recovered length in microseconds.
#[tauri::command(async)]
pub fn recover_project(allowed: State<'_, Allowed>, dir: String) -> Result<i64, String> {
    let dir = checked(&allowed, &dir)?;
    if !needs_recovery(&dir) {
        return Err("This recording does not need recovery.".into());
    }
    let ffprobe = marz_capture::ffmpeg::find_ffprobe().map_err(err)?;
    Ok(recover(&dir, &ffprobe).map_err(err)?.duration_us)
}

/// Move a `.marz` folder to the Recycle Bin. Never a hard delete.
#[tauri::command(async)]
pub fn discard_project(window: WebviewWindow, allowed: State<'_, Allowed>, dir: String) -> Result<(), String> {
    let path = checked(&allowed, &dir)?;
    if !has_marz_suffix(&path) || !is_real_dir(&path) {
        return Err("Only a .marz folder can be discarded.".into());
    }
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    recycle::to_recycle_bin(&path, owner)?;
    allowed.0.lock().map_err(err)?.remove(&path);
    Ok(())
}

#[cfg(windows)]
mod recycle {
    use std::path::Path;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};
    use windows::Win32::UI::Shell::{
        FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_WANTNUKEWARNING, FileOperation, IFileOperation, IShellItem,
        SHCreateItemFromParsingName,
    };
    use windows::core::HSTRING;

    /// `IFileOperation` delete with FOF_ALLOWUNDO, which sends the folder to the Recycle Bin.
    /// FOF_WANTNUKEWARNING makes Windows ask first if the item cannot be recycled, so a
    /// permanent delete never happens silently. Runs on its own thread to own COM.
    pub fn to_recycle_bin(path: &Path, owner: isize) -> Result<(), String> {
        let path = path.to_path_buf();
        let worker = std::thread::spawn(move || -> Result<(), String> {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|e| e.to_string())?;
                let result = (|| -> windows::core::Result<bool> {
                    let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
                    op.SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_NOERRORUI)?;
                    if owner != 0 {
                        op.SetOwnerWindow(HWND(owner as *mut _))?;
                    }
                    let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)?;
                    op.DeleteItem(&item, None)?;
                    op.PerformOperations()?;
                    Ok(op.GetAnyOperationsAborted()?.as_bool())
                })();
                CoUninitialize();
                match result {
                    Ok(false) if !path.exists() => Ok(()),
                    Ok(_) => Err("The folder was not moved to the Recycle Bin.".into()),
                    Err(e) => Err(e.to_string()),
                }
            }
        });
        worker.join().map_err(|_| "The Recycle Bin move failed.".to_string())?
    }
}

#[cfg(not(windows))]
mod recycle {
    pub fn to_recycle_bin(_path: &std::path::Path, _owner: isize) -> Result<(), String> {
        Err("Moving to the Recycle Bin needs Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-projects-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project(root: &Path, folder: &str, name: &str, zooms: usize, cuts: usize) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        let z: Vec<Value> = (0..zooms).map(|i| serde_json::json!({ "id": i })).collect();
        let c: Vec<Value> = (0..cuts).map(|i| serde_json::json!({ "id": i })).collect();
        let doc = serde_json::json!({ "name": name, "durationUs": 160_000_000, "edits": { "zooms": z, "cuts": c } });
        fs::write(dir.join(PROJECT_JSON), doc.to_string()).unwrap();
        dir
    }

    #[test]
    fn scan_lists_marz_folders_with_counts() {
        let root = temp_dir("scan");
        project(&root, "a.marz", "Checkout bug walkthrough", 3, 1);
        project(&root, "not-a-project", "Ignored", 0, 0);
        fs::create_dir_all(root.join("empty.marz")).unwrap();
        let rows = scan(&root, None).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r.name.as_str(), r.duration_us, r.zooms, r.cuts, r.needs_recovery), ("Checkout bug walkthrough", 160_000_000, 3, 1, false));
        assert!(r.edited_at > 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_sorts_newest_first() {
        let root = temp_dir("order");
        let old = project(&root, "old.marz", "Old", 0, 0);
        let old_file = fs::File::options().write(true).open(old.join(PROJECT_JSON)).unwrap();
        old_file.set_modified(SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        drop(old_file);
        project(&root, "new.marz", "New", 0, 0);
        let names: Vec<String> = scan(&root, None).unwrap().into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["New", "Old"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn killed_recording_needs_recovery_and_takes_its_name_from_the_marker() {
        let root = temp_dir("crash");
        let dir = root.join("crash.marz");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CRASH_MARKER), r#"{"name":"Pricing page walkthrough","fps":60}"#).unwrap();
        let rows = scan(&root, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].needs_recovery);
        assert_eq!(rows[0].name, "Pricing page walkthrough");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_project_json_and_events_are_readable() {
        let dir = Path::new("C:/x.marz");
        assert!(readable_path(dir, "project.json").is_ok());
        assert!(readable_path(dir, "events.jsonl").is_ok());
        for bad in ["screen.mp4", "../secret.txt", "..\\project.json", "sub/project.json", "C:/Windows/win.ini", ""] {
            assert!(readable_path(dir, bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn atomic_write_replaces_project_json_and_leaves_no_temp_file() {
        let root = temp_dir("write");
        let dir = project(&root, "w.marz", "Before", 0, 0);
        write_project_json_atomic(&dir, r#"{"name":"After"}"#).unwrap();
        assert_eq!(fs::read_to_string(dir.join(PROJECT_JSON)).unwrap(), r#"{"name":"After"}"#);
        assert!(!dir.join("project.json.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_write_refuses_text_that_is_not_json() {
        let root = temp_dir("badjson");
        let dir = project(&root, "w.marz", "Kept", 0, 0);
        assert!(write_project_json_atomic(&dir, "{not json").is_err());
        assert!(fs::read_to_string(dir.join(PROJECT_JSON)).unwrap().contains("Kept"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn two_saves_at_once_never_mix() {
        let root = temp_dir("race");
        let dir = project(&root, "r.marz", "Start", 0, 0);
        // Big documents so a write takes long enough to overlap.
        let doc = |tag: &str| serde_json::json!({ "name": tag, "pad": tag.repeat(400_000) }).to_string();
        let (a, b) = (doc("a"), doc("b"));
        let threads: Vec<_> = [a.clone(), b.clone()]
            .into_iter()
            .map(|text| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        write_project_json_atomic(&dir, &text).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let saved = fs::read_to_string(dir.join(PROJECT_JSON)).unwrap();
        assert!(saved == a || saved == b, "project.json is a mix of two saves ({} bytes)", saved.len());
        assert!(!dir.join("project.json.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_save_leaves_no_temp_file() {
        let root = temp_dir("failsave");
        let dir = project(&root, "f.marz", "Kept", 0, 0);
        // The rename fails when project.json is a non-empty folder.
        fs::remove_file(dir.join(PROJECT_JSON)).unwrap();
        fs::create_dir_all(dir.join(PROJECT_JSON).join("x")).unwrap();
        assert!(write_project_json_atomic(&dir, r#"{"name":"New"}"#).is_err());
        assert!(!dir.join("project.json.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_marz_junction_is_not_followed() {
        let root = temp_dir("junction");
        let target = project(&root, "real.marz", "Real", 0, 0);
        let scan_root = root.join("scan");
        fs::create_dir_all(&scan_root).unwrap();
        let link = scan_root.join("link.marz");
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().unwrap().status.success();
        assert!(ok, "mklink /J failed");
        assert!(scan(&scan_root, None).unwrap().is_empty());
        assert!(!is_project_folder(&link));
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn project_folder_rule() {
        let root = temp_dir("rule");
        let named = root.join("x.marz");
        fs::create_dir_all(&named).unwrap();
        let with_json = project(&root, "plain", "P", 0, 0);
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(is_project_folder(&named));
        assert!(is_project_folder(&with_json));
        assert!(!is_project_folder(&other));
        fs::remove_dir_all(&root).unwrap();
    }
}
