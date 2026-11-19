//! Export commands. The page composites and encodes the video (WebCodecs) and streams the H.264
//! chunks here; `marz_export::ExportProcess` muxes them with the mic in FFmpeg.
//!
//! The page never names a file: `pick_export_path` runs the save dialog here and remembers the
//! path it returned, and `export_begin` accepts only that path and an allow-listed project folder.

use crate::projects::{self, Allowed};
use marz_export::{CancelHandle, ExportJob, ExportProcess, ExportReport};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Chunks queued between the IPC handler and the writer thread (about 1 to 2 s of video).
const QUEUE: usize = 64;
/// Header that carries the export id on `export_chunk` (the body is the raw chunk).
const ID_HEADER: &str = "marz-export-id";

pub const MISSING_FFMPEG: &str = "FFmpeg is missing. Install it or set MARZ_FFMPEG";
pub const NOT_WRITABLE: &str = "This folder cannot be written to. Pick another folder";
pub const FFMPEG_FAILED: &str = "FFmpeg stopped with an error";
pub const CANCELLED: &str = "Export cancelled";
pub const INSIDE_PROJECT: &str = "Pick a folder outside the project";
const NOT_SET_UP: &str = "This export was not set up from the editor";

/// What the page shows: `reason` is a sentence for the warning bar, `detail` goes to the console.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportError {
    pub reason: String,
    pub detail: String,
}

impl ExportError {
    fn new(reason: &str, detail: impl Into<String>) -> Self {
        Self { reason: reason.to_string(), detail: detail.into() }
    }
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Preset {
    Youtube,
    Vertical,
}

/// Why an export stopped early, shared by the writer thread and the IPC handler.
type Failure = Arc<Mutex<Option<ExportError>>>;

enum Msg {
    Chunk(Vec<u8>),
    Finish,
}

struct Running {
    tx: SyncSender<Msg>,
    cancel: CancelHandle,
    failure: Failure,
    worker: JoinHandle<Result<ExportReport, ExportError>>,
}

/// Running exports, the paths the save dialog returned, and the files that were written.
#[derive(Default)]
pub struct Exports {
    next: AtomicU32,
    running: Mutex<HashMap<u32, Running>>,
    picked: Mutex<HashSet<PathBuf>>,
    done: Mutex<HashSet<PathBuf>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `<project name> YouTube.mp4` or `<project name> Vertical.mp4`, with the characters Windows does
/// not allow in a file name removed.
pub fn export_file_name(project_name: &str, preset: Preset) -> String {
    let cleaned: String = project_name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c }).collect();
    let mut name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    name = name.trim_end_matches(['.', ' ']).to_string();
    if name.chars().count() > 100 {
        name = name.chars().take(100).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    if name.is_empty() {
        name = "Untitled".into();
    }
    let suffix = match preset {
        Preset::Youtube => "YouTube",
        Preset::Vertical => "Vertical",
    };
    format!("{name} {suffix}.mp4")
}

/// What to do with the path the save dialog returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Picked {
    /// Export to this path.
    Use(PathBuf),
    /// The name is not `.mp4`: open the dialog again on this `.mp4` name, so the dialog itself
    /// asks before an existing file is replaced (adding `.mp4` here would skip that question).
    Ask(PathBuf),
    /// Inside a project folder, where an export could replace a raw track: `INSIDE_PROJECT`.
    Refuse,
}

fn is_mp4(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
}

/// Lowercase with forward slashes and no trailing slash, to compare Windows paths.
fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// True when `out` lies inside a project: below any `.marz` folder, or below one of the folders
/// the app opened (`allowed`). Raw tracks live there and are never overwritten.
pub fn inside_project(out: &Path, allowed: &HashSet<PathBuf>) -> bool {
    let in_marz = out.ancestors().skip(1).any(|a| a.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("marz")));
    let key = path_key(out);
    in_marz || allowed.iter().any(|d| key.starts_with(&format!("{}/", path_key(d))))
}

/// Check the dialog's path: `.mp4`, outside every project folder.
pub fn check_picked(path: PathBuf, allowed: &HashSet<PathBuf>) -> Picked {
    if !is_mp4(&path) {
        return Picked::Ask(if path.extension().is_some() { path.with_extension("mp4") } else { PathBuf::from(format!("{}.mp4", path.to_string_lossy())) });
    }
    if inside_project(&path, allowed) {
        return Picked::Refuse;
    }
    Picked::Use(path)
}

/// A plain file name inside the project folder (no folders, no `..`).
fn is_plain_file_name(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None)) && !name.contains(['/', '\\', ':'])
}

/// The job the page sent, checked against what Rust allowed: the project folder came from Home or
/// the folder dialog, the output path came from `pick_export_path`, and the numbers are sane.
pub fn validate_job(job: &ExportJob, allowed_dirs: &HashSet<PathBuf>, picked: &HashSet<PathBuf>) -> Result<(), ExportError> {
    let bad = |d: &str| Err(ExportError::new(NOT_SET_UP, d));
    if !allowed_dirs.contains(&job.project_dir) {
        return bad("project folder is not open");
    }
    if !picked.contains(&job.out_path) {
        return bad("output path did not come from the save dialog");
    }
    if inside_project(&job.out_path, allowed_dirs) {
        return Err(ExportError::new(INSIDE_PROJECT, "output path is inside a project folder"));
    }
    if let Some(mic) = &job.mic
        && !is_plain_file_name(&mic.file)
    {
        return bad("mic file is not a file in the project folder");
    }
    if let Some(sys) = &job.system
        && !is_plain_file_name(&sys.file)
    {
        return bad("computer sound file is not a file in the project folder");
    }
    let even = |v: u32| (16..=7680).contains(&v) && v.is_multiple_of(2);
    if !even(job.width) || !even(job.height) || !(1..=120).contains(&job.fps) {
        return bad("size or frame rate out of range");
    }
    if job.segments.is_empty() || job.output_duration_us <= 0 {
        return bad("nothing to export");
    }
    let mut out = 0i64;
    for s in &job.segments {
        if s.src_start_us < 0 || s.src_end_us <= s.src_start_us || s.out_start_us != out {
            return bad("segments are not in order");
        }
        out += s.src_end_us - s.src_start_us;
    }
    if out != job.output_duration_us {
        return bad("segments do not add up to the output length");
    }
    Ok(())
}

/// Can FFmpeg create `<out>.part`? Checked before FFmpeg starts so the reason is clear.
pub fn check_writable(out: &Path) -> Result<(), ExportError> {
    let part = marz_export::args::part_path(out);
    match std::fs::File::create(&part) {
        Ok(f) => {
            drop(f);
            let _ = std::fs::remove_file(&part);
            Ok(())
        }
        Err(e) => Err(ExportError::new(NOT_WRITABLE, e.to_string())),
    }
}

fn ffmpeg_error(e: &str) -> ExportError {
    if e == "export cancelled" { ExportError::new(CANCELLED, e) } else { ExportError::new(FFMPEG_FAILED, e) }
}

/// The writer thread: one per export, so the IPC handler only queues chunks. A write that fails
/// (FFmpeg exited) finishes the process at once and records why; later chunks are dropped. A
/// closed channel without `Finish` means cancel.
fn writer(process: ExportProcess, rx: Receiver<Msg>, failure: Failure) -> Result<ExportReport, ExportError> {
    let mut process = Some(process);
    let mut early: Option<Result<ExportReport, String>> = None;
    let mut finish = false;
    for msg in rx.iter() {
        match msg {
            Msg::Chunk(bytes) => {
                if let Some(p) = process.as_mut()
                    && p.write_chunk(&bytes).is_err()
                {
                    let result = process.take().map(ExportProcess::finish).unwrap_or_else(|| Err("ffmpeg is gone".into()));
                    if let Err(e) = &result {
                        *lock(&failure) = Some(ffmpeg_error(e));
                    }
                    early = Some(result);
                }
            }
            Msg::Finish => {
                finish = true;
                break;
            }
        }
    }
    if !finish {
        if let Some(p) = process {
            p.cancel();
        }
        return Err(ExportError::new(CANCELLED, "export cancelled"));
    }
    let result = match (early, process) {
        (Some(r), _) => r,
        (None, Some(p)) => p.finish(),
        (None, None) => Err("ffmpeg is gone".into()),
    };
    result.map_err(|e| ffmpeg_error(&e))
}

impl Exports {
    /// Start FFmpeg for a checked job and its writer thread. Returns the export id.
    fn begin(&self, ffmpeg: &Path, job: ExportJob) -> Result<u32, ExportError> {
        check_writable(&job.out_path)?;
        let process = ExportProcess::start(ffmpeg, job).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { ExportError::new(MISSING_FFMPEG, e.to_string()) } else { ExportError::new(FFMPEG_FAILED, e.to_string()) }
        })?;
        let cancel = process.cancel_handle();
        let failure = Arc::new(Mutex::new(None));
        let (tx, rx) = sync_channel(QUEUE);
        let f = Arc::clone(&failure);
        let worker = std::thread::Builder::new()
            .name("marz-export-writer".into())
            .spawn(move || writer(process, rx, f))
            .map_err(|e| ExportError::new(FFMPEG_FAILED, e.to_string()))?;
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        lock(&self.running).insert(id, Running { tx, cancel, failure, worker });
        Ok(id)
    }

    /// The sender and failure slot of a running export.
    fn sender(&self, id: u32) -> Result<(SyncSender<Msg>, Failure), ExportError> {
        let running = lock(&self.running);
        let r = running.get(&id).ok_or_else(|| ExportError::new(CANCELLED, format!("export {id} is not running")))?;
        Ok((r.tx.clone(), Arc::clone(&r.failure)))
    }

    /// Queue one chunk (blocks while the queue is full). Fails once FFmpeg has stopped. The same
    /// steps as `export_chunk`, without the async runtime, for the tests.
    #[cfg(test)]
    fn chunk(&self, id: u32, bytes: Vec<u8>) -> Result<(), ExportError> {
        let (tx, failure) = self.sender(id)?;
        if let Some(e) = lock(&failure).clone() {
            return Err(e);
        }
        if tx.send(Msg::Chunk(bytes)).is_err() {
            return Err(lock(&failure).clone().unwrap_or_else(|| ExportError::new(CANCELLED, "writer stopped")));
        }
        Ok(())
    }

    fn finish(&self, id: u32) -> Result<ExportReport, ExportError> {
        let r = lock(&self.running).remove(&id).ok_or_else(|| ExportError::new(CANCELLED, format!("export {id} is not running")))?;
        let _ = r.tx.send(Msg::Finish);
        drop(r.tx);
        let report = r.worker.join().map_err(|_| ExportError::new(FFMPEG_FAILED, "the export writer panicked"))??;
        lock(&self.done).insert(report.out_path.clone());
        Ok(report)
    }

    /// Kill FFmpeg and remove `.part`. An unknown id (never begun, or already over) is fine.
    fn cancel(&self, id: u32) {
        let Some(r) = lock(&self.running).remove(&id) else { return };
        r.cancel.cancel();
        drop(r.tx);
        let _ = r.worker.join();
    }

    /// Cancel everything (the app is closing, or the page reloaded).
    pub fn cancel_all(&self) {
        let ids: Vec<u32> = lock(&self.running).keys().copied().collect();
        for id in ids {
            self.cancel(id);
        }
    }
}

fn project_name(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("project.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["name"].as_str().map(str::to_string))
        .unwrap_or_else(|| projects::folder_name(dir))
}

/// The save dialog for an export, run here so the page never hands over a path. Starts in the
/// projects folder's `Exports` folder with the default name. None when the person cancels. A name
/// that is not `.mp4` opens the dialog again on the `.mp4` name; a folder inside a project is
/// refused with `INSIDE_PROJECT`.
#[tauri::command(async)]
pub fn pick_export_path(
    app: AppHandle,
    window: WebviewWindow,
    allowed: State<'_, Allowed>,
    exports: State<'_, Exports>,
    project_dir: String,
    preset: Preset,
) -> Result<Option<String>, ExportError> {
    let fail = |e: String| ExportError::new(NOT_WRITABLE, e);
    let dir = projects::checked(&allowed, &project_dir).map_err(|e| ExportError::new(NOT_SET_UP, e))?;
    let exports_dir = projects::default_dir(&app).map_err(fail)?.join("Exports");
    std::fs::create_dir_all(&exports_dir).map_err(|e| fail(e.to_string()))?;
    let mut start = exports_dir.join(export_file_name(&project_name(&dir), preset));
    let path = loop {
        let chosen = match dev_export_dir() {
            Some(d) => d.join(start.file_name().unwrap_or_default()),
            None => {
                let mut dialog = app.dialog().file().set_title("Export MP4").set_parent(&window).add_filter("MP4", &["mp4"]);
                if let Some(parent) = start.parent() {
                    dialog = dialog.set_directory(parent);
                }
                if let Some(name) = start.file_name().and_then(|n| n.to_str()) {
                    dialog = dialog.set_file_name(name);
                }
                let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
                picked.into_path().map_err(|e| fail(e.to_string()))?
            }
        };
        let allowed_dirs = lock(&allowed.0).clone();
        match check_picked(chosen, &allowed_dirs) {
            Picked::Use(p) => break p,
            Picked::Ask(p) => start = p,
            Picked::Refuse => return Err(ExportError::new(INSIDE_PROJECT, "the save dialog picked a project folder")),
        }
    };
    lock(&exports.picked).insert(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Debug builds only: `MARZ_DEV_EXPORT_DIR` skips the dialog and uses the default name in that
/// folder, so the end-to-end checks can run without clicking in a native dialog.
fn dev_export_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) { std::env::var_os("MARZ_DEV_EXPORT_DIR").map(PathBuf::from) } else { None }
}

#[tauri::command(async)]
pub fn export_begin(allowed: State<'_, Allowed>, exports: State<'_, Exports>, job: ExportJob) -> Result<u32, ExportError> {
    {
        let dirs = lock(&allowed.0);
        let mut picked = lock(&exports.picked);
        validate_job(&job, &dirs, &picked)?;
        picked.remove(&job.out_path);
    }
    let ffmpeg = marz_export::tools::find_ffmpeg().map_err(|e| ExportError::new(MISSING_FFMPEG, e.to_string()))?;
    exports.begin(&ffmpeg, job)
}

/// One H.264 chunk as the raw request body; the export id is in the `marz-export-id` header.
#[tauri::command]
pub async fn export_chunk(request: Request<'_>, exports: State<'_, Exports>) -> Result<(), ExportError> {
    let id: u32 = request
        .headers()
        .get(ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ExportError::new(NOT_SET_UP, "missing export id"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ExportError::new(NOT_SET_UP, "chunk must be a raw body"));
    };
    let bytes = bytes.clone();
    let (tx, failure) = exports.sender(id)?;
    if let Some(e) = lock(&failure).clone() {
        return Err(e);
    }
    // A full queue blocks a pool thread, never the IPC handler or the main thread.
    let sent = tauri::async_runtime::spawn_blocking(move || tx.send(Msg::Chunk(bytes)).is_ok()).await.unwrap_or(false);
    if !sent {
        return Err(lock(&failure).clone().unwrap_or_else(|| ExportError::new(CANCELLED, "writer stopped")));
    }
    Ok(())
}

#[tauri::command]
pub async fn export_finish(app: AppHandle, id: u32) -> Result<ExportReport, ExportError> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Exports>().finish(id))
        .await
        .map_err(|e| ExportError::new(FFMPEG_FAILED, e.to_string()))?
}

#[tauri::command]
pub async fn export_cancel(app: AppHandle, id: Option<u32>) -> Result<(), String> {
    let Some(id) = id else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || app.state::<Exports>().cancel(id)).await.map_err(|e| e.to_string())
}

/// Cancel every running export: the page calls this when it loads, so a reload in the middle of an
/// export leaves no FFmpeg process and no `.part` file.
#[tauri::command]
pub async fn export_cancel_all(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Exports>().cancel_all()).await.map_err(|e| e.to_string())
}

/// The `.srt` beside an MP4: same name, `.srt` extension.
pub fn srt_path(mp4: &Path) -> PathBuf {
    mp4.with_extension("srt")
}

/// Write `text` through `<name>.srt.part` and a rename (the export's `.part` rule).
pub fn write_srt_atomic(mp4: &Path, text: &str) -> std::io::Result<PathBuf> {
    write_beside_atomic(mp4, "srt", text)
}

/// Write `text` to `<name>.<ext>` beside the MP4 through a `.part` file and a rename.
pub fn write_beside_atomic(mp4: &Path, ext: &str, text: &str) -> std::io::Result<PathBuf> {
    let dest = mp4.with_extension(ext);
    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    std::fs::write(&part, text.as_bytes())?;
    if let Err(e) = std::fs::rename(&part, &dest) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    Ok(dest)
}

/// Captions as SubRip beside a finished export. Only for MP4s this app just exported.
#[tauri::command(async)]
pub fn export_write_srt(exports: State<'_, Exports>, out_path: String, text: String) -> Result<String, String> {
    let mp4 = PathBuf::from(&out_path);
    if !lock(&exports.done).contains(&mp4) {
        return Err("This file was not exported here".into());
    }
    write_srt_atomic(&mp4, &text).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

/// Captions as WebVTT beside a finished export. Only for MP4s this app just exported.
#[tauri::command(async)]
pub fn export_write_vtt(exports: State<'_, Exports>, out_path: String, text: String) -> Result<String, String> {
    let mp4 = PathBuf::from(&out_path);
    if !lock(&exports.done).contains(&mp4) {
        return Err("This file was not exported here".into());
    }
    write_beside_atomic(&mp4, "vtt", &text).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

/// Open Explorer with a finished export selected. Only files this app exported.
#[tauri::command]
pub fn show_in_folder(exports: State<'_, Exports>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !lock(&exports.done).contains(&path) {
        return Err("This file was not exported here.".into());
    }
    open_explorer(&path)
}

#[cfg(windows)]
fn open_explorer(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    cmd.spawn().map(drop).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn open_explorer(_path: &Path) -> Result<(), String> {
    Err("Show in folder needs Windows.".into())
}

#[cfg(test)]
mod srt_tests {
    use super::*;

    #[test]
    fn writes_the_srt_beside_the_mp4_without_a_part_file() {
        let dir = std::env::temp_dir().join(format!("marz-srt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp4 = dir.join("Demo YouTube.mp4");
        let srt = write_srt_atomic(&mp4, "1
00:00:00,000 --> 00:00:01,000
Hi

").unwrap();
        assert_eq!(srt, dir.join("Demo YouTube.srt"));
        assert!(std::fs::read_to_string(&srt).unwrap().contains("Hi"));
        assert!(!dir.join("Demo YouTube.srt.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_the_vtt_beside_the_mp4_without_a_part_file() {
        let dir = std::env::temp_dir().join(format!("marz-vtt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp4 = dir.join("Demo Vertical.mp4");
        let vtt = write_beside_atomic(&mp4, "vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n\n").unwrap();
        assert_eq!(vtt, dir.join("Demo Vertical.vtt"));
        assert!(std::fs::read_to_string(&vtt).unwrap().starts_with("WEBVTT"));
        assert!(!dir.join("Demo Vertical.vtt.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use marz_export::{MicJob, Segment};
    use std::process::Stdio;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-exportcmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn job(dir: &Path, out: &Path) -> ExportJob {
        ExportJob {
            project_dir: dir.to_path_buf(),
            out_path: out.to_path_buf(),
            width: 320,
            height: 180,
            fps: 30,
            segments: vec![
                Segment { src_start_us: 0, src_end_us: 1_200_000, out_start_us: 0 },
                Segment { src_start_us: 1_500_000, src_end_us: 2_300_000, out_start_us: 1_200_000 },
            ],
            mic: None,
            system: None,
            output_duration_us: 2_000_000,
        }
    }

    fn sets(dir: &Path, out: &Path) -> (HashSet<PathBuf>, HashSet<PathBuf>) {
        (HashSet::from([dir.to_path_buf()]), HashSet::from([out.to_path_buf()]))
    }

    #[test]
    fn file_names_follow_the_preset_and_drop_bad_characters() {
        assert_eq!(export_file_name("Checkout bug walkthrough", Preset::Youtube), "Checkout bug walkthrough YouTube.mp4");
        assert_eq!(export_file_name("Checkout bug walkthrough", Preset::Vertical), "Checkout bug walkthrough Vertical.mp4");
        assert_eq!(export_file_name("Q3: plan/v2?", Preset::Youtube), "Q3 plan v2 YouTube.mp4");
        assert_eq!(export_file_name("  ends with dots...", Preset::Vertical), "ends with dots Vertical.mp4");
        assert_eq!(export_file_name("<>|*", Preset::Youtube), "Untitled YouTube.mp4");
        assert_eq!(export_file_name("", Preset::Vertical), "Untitled Vertical.mp4");
        let long = "a".repeat(300);
        assert_eq!(export_file_name(&long, Preset::Youtube).len(), 100 + " YouTube.mp4".len());
    }

    #[test]
    fn a_name_that_is_not_mp4_goes_back_to_the_dialog_as_mp4() {
        let none = HashSet::new();
        assert_eq!(check_picked(PathBuf::from("C:/x/clip.mp4"), &none), Picked::Use(PathBuf::from("C:/x/clip.mp4")));
        assert_eq!(check_picked(PathBuf::from("C:/x/clip.MP4"), &none), Picked::Use(PathBuf::from("C:/x/clip.MP4")));
        // Never "clip.mov.mp4" written silently over an existing file: the dialog asks again.
        assert_eq!(check_picked(PathBuf::from("C:/x/clip.mov"), &none), Picked::Ask(PathBuf::from("C:/x/clip.mp4")));
        assert_eq!(check_picked(PathBuf::from("C:/x/clip"), &none), Picked::Ask(PathBuf::from("C:/x/clip.mp4")));
    }

    #[test]
    fn an_export_inside_a_project_folder_is_refused() {
        let dir = PathBuf::from("C:/v/a.marz");
        let allowed = HashSet::from([dir.clone(), PathBuf::from("D:/Other/b")]);
        for out in ["C:/v/a.marz/screen.mp4", "C:/v/A.MARZ/sub/x.mp4", "C:/elsewhere/c.marz/x.mp4", "D:/Other/b/x.mp4", "d:/other/B/x.mp4"] {
            assert!(inside_project(Path::new(out), &allowed), "{out}");
            assert_eq!(check_picked(PathBuf::from(out), &allowed), Picked::Refuse, "{out}");
        }
        for out in ["C:/v/Exports/a YouTube.mp4", "C:/v/a.marz.mp4", "D:/Other/bb/x.mp4", "C:/v/x.mp4"] {
            assert!(!inside_project(Path::new(out), &allowed), "{out}");
        }
        // validate_job refuses it too, with the sentence.
        let out = dir.join("screen.mp4");
        let (dirs, picked) = sets(&dir, &out);
        let err = validate_job(&job(&dir, &out), &dirs, &picked).unwrap_err();
        assert_eq!(err.reason, INSIDE_PROJECT);
        assert_eq!(INSIDE_PROJECT, "Pick a folder outside the project");
    }

    #[test]
    fn a_job_needs_an_open_project_and_a_picked_path() {
        let dir = PathBuf::from("C:/v/a.marz");
        let out = PathBuf::from("C:/v/Exports/a YouTube.mp4");
        let j = job(&dir, &out);
        let (dirs, picked) = sets(&dir, &out);
        assert_eq!(validate_job(&j, &dirs, &picked), Ok(()));
        assert_eq!(validate_job(&j, &HashSet::new(), &picked).unwrap_err().reason, NOT_SET_UP);
        assert_eq!(validate_job(&j, &dirs, &HashSet::new()).unwrap_err().reason, NOT_SET_UP);
        let other = job(&dir, Path::new("C:/Windows/evil.mp4"));
        assert!(validate_job(&other, &dirs, &picked).is_err());
    }

    #[test]
    fn a_job_with_a_bad_mic_name_or_numbers_is_refused() {
        let dir = PathBuf::from("C:/v/a.marz");
        let out = PathBuf::from("C:/v/out.mp4");
        let (dirs, picked) = sets(&dir, &out);
        for file in ["../secret.wav", "C:/x.wav", "sub/mic.wav", "..", ""] {
            let mut j = job(&dir, &out);
            j.mic = Some(MicJob { file: file.into(), offset_us: 0, volume: 1.0, muted: false });
            assert!(validate_job(&j, &dirs, &picked).is_err(), "{file} must be refused");
        }
        let mut j = job(&dir, &out);
        j.mic = Some(MicJob { file: "mic.wav".into(), offset_us: 12_400, volume: 1.0, muted: false });
        assert_eq!(validate_job(&j, &dirs, &picked), Ok(()));
        let mut j = job(&dir, &out);
        j.width = 321;
        assert!(validate_job(&j, &dirs, &picked).is_err());
        let mut j = job(&dir, &out);
        j.fps = 0;
        assert!(validate_job(&j, &dirs, &picked).is_err());
        let mut j = job(&dir, &out);
        j.output_duration_us = 3_000_000;
        assert!(validate_job(&j, &dirs, &picked).is_err());
        let mut j = job(&dir, &out);
        j.segments[1].out_start_us = 0;
        assert!(validate_job(&j, &dirs, &picked).is_err());
        let mut j = job(&dir, &out);
        j.segments.clear();
        assert!(validate_job(&j, &dirs, &picked).is_err());
    }

    #[test]
    fn an_unwritable_folder_is_reported_before_ffmpeg_starts() {
        let dir = temp_dir("writable");
        assert_eq!(check_writable(&dir.join("ok.mp4")), Ok(()));
        assert!(!dir.join("ok.mp4.part").exists());
        let err = check_writable(&dir.join("missing").join("x.mp4")).unwrap_err();
        assert_eq!(err.reason, NOT_WRITABLE);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_without_begin_is_harmless() {
        let exports = Exports::default();
        exports.cancel(7);
        exports.cancel_all();
        assert_eq!(exports.chunk(7, vec![0; 4]).unwrap_err().reason, CANCELLED);
        assert_eq!(exports.finish(7).unwrap_err().reason, CANCELLED);
    }

    #[test]
    fn a_missing_ffmpeg_is_named() {
        let dir = temp_dir("noffmpeg");
        let exports = Exports::default();
        let err = exports.begin(&dir.join("no-ffmpeg.exe"), job(&dir, &dir.join("out.mp4"))).unwrap_err();
        assert_eq!(err.reason, MISSING_FFMPEG);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn h264(ffmpeg: &Path) -> Vec<u8> {
        let out = marz_export::tools::command(ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
    }

    #[test]
    fn chunks_go_through_the_writer_thread_into_the_mp4() {
        let Ok(ffmpeg) = marz_export::tools::find_ffmpeg() else { return eprintln!("skipped: no ffmpeg") };
        let dir = temp_dir("roundtrip");
        let out = dir.join("out.mp4");
        let exports = Exports::default();
        let id = exports.begin(&ffmpeg, job(&dir, &out)).unwrap();
        for c in h264(&ffmpeg).chunks(4096) {
            exports.chunk(id, c.to_vec()).unwrap();
        }
        let report = exports.finish(id).unwrap();
        assert_eq!(report.out_path, out);
        assert!(report.size_bytes > 1000);
        assert!(out.is_file() && !marz_export::args::part_path(&out).exists());
        assert!(lock(&exports.done).contains(&out));
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["durationUs"], 2_000_000);
        assert!(json["outPath"].is_string() && json["sizeBytes"].is_number());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_mid_export_kills_ffmpeg_and_removes_part() {
        let Ok(ffmpeg) = marz_export::tools::find_ffmpeg() else { return eprintln!("skipped: no ffmpeg") };
        let dir = temp_dir("cancelmid");
        let out = dir.join("out.mp4");
        std::fs::write(&out, b"precious").unwrap();
        let exports = Exports::default();
        let id = exports.begin(&ffmpeg, job(&dir, &out)).unwrap();
        let data = h264(&ffmpeg);
        exports.chunk(id, data[..data.len() / 2].to_vec()).unwrap();
        exports.cancel(id);
        assert!(!marz_export::args::part_path(&out).exists());
        assert_eq!(std::fs::read(&out).unwrap(), b"precious");
        assert!(exports.chunk(id, vec![0; 4]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_all_stops_a_running_export_and_removes_part() {
        let Ok(ffmpeg) = marz_export::tools::find_ffmpeg() else { return eprintln!("skipped: no ffmpeg") };
        let dir = temp_dir("cancelall");
        let out = dir.join("out.mp4");
        let exports = Exports::default();
        let id = exports.begin(&ffmpeg, job(&dir, &out)).unwrap();
        let data = h264(&ffmpeg);
        exports.chunk(id, data[..data.len() / 2].to_vec()).unwrap();
        // A page reload: the page asks Rust to cancel whatever it left running.
        exports.cancel_all();
        assert!(lock(&exports.running).is_empty());
        assert!(!out.exists() && !marz_export::args::part_path(&out).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn garbage_fails_with_the_ffmpeg_reason() {
        let Ok(ffmpeg) = marz_export::tools::find_ffmpeg() else { return eprintln!("skipped: no ffmpeg") };
        let dir = temp_dir("garbage");
        let out = dir.join("out.mp4");
        let exports = Exports::default();
        let id = exports.begin(&ffmpeg, job(&dir, &out)).unwrap();
        // FFmpeg may exit while chunks are still coming; either a chunk or finish reports it.
        let mut err = None;
        for _ in 0..200 {
            if let Err(e) = exports.chunk(id, vec![0x13; 8192]) {
                err = Some(e);
                break;
            }
        }
        let err = err.unwrap_or_else(|| exports.finish(id).unwrap_err());
        assert_eq!(err.reason, FFMPEG_FAILED);
        exports.cancel(id);
        assert!(!out.exists() && !marz_export::args::part_path(&out).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
