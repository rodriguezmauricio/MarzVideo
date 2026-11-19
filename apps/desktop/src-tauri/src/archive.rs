//! Archive and proxies (docs/superpowers/specs/2026-11-19-archive-proxies-design.md).
//!
//! Archive copies a `.marz` folder to a destination folder (meant for Google Drive for desktop) and
//! checks every copied file by size and SHA-256. After that, and only on an explicit step, the raw
//! video files can go to the Recycle Bin; the editor then plays small proxies from `proxies/`.
//! Restore copies them back from the archive, checked against the same hashes. Raw files are never
//! modified. The state lives in `archive.json` in the folder, written only here.

use crate::projects::{Allowed, checked};
use marz_capture::project::iso_utc_now;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State as TauriState, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub const STATE_FILE: &str = "archive.json";
const SETTINGS_FILE: &str = "archive-settings.json";
/// Folders inside a project that are derived and never archived.
const SKIP_DIRS: [&str; 2] = ["cache", "proxies"];
const PROXY_DIR: &str = "proxies";
const BUF: usize = 1 << 20;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// One archived file: its path in the folder (forward slashes), size and SHA-256 (hex).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

impl FileEntry {
    fn to_json(&self) -> Value {
        json!({ "path": self.path, "size": self.size, "sha256": self.sha256 })
    }
}

/// `archive.json`. Kept as a JSON map so keys a newer build wrote survive a rewrite.
#[derive(Debug, Default, Clone)]
pub struct ArchiveState(Map<String, Value>);

impl ArchiveState {
    pub fn read(dir: &Path) -> Self {
        let doc = fs::read_to_string(dir.join(STATE_FILE)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        match doc {
            Some(Value::Object(m)) => Self(m),
            _ => Self::default(),
        }
    }

    /// Through a temp file and a rename, like project.json.
    pub fn write(&self, dir: &Path) -> io::Result<()> {
        let tmp = dir.join("archive.json.tmp");
        let text = serde_json::to_string_pretty(&Value::Object(self.0.clone()))? + "\n";
        let result = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, dir.join(STATE_FILE))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    pub fn archive_dir(&self) -> Option<PathBuf> {
        self.0.get("archive")?.get("dir")?.as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
    }

    pub fn archived_at(&self) -> Option<String> {
        self.0.get("archive")?.get("at")?.as_str().map(str::to_string)
    }

    pub fn files(&self) -> Vec<FileEntry> {
        let Some(list) = self.0.get("archive").and_then(|a| a.get("files")).and_then(Value::as_array) else { return vec![] };
        list.iter()
            .filter_map(|f| {
                Some(FileEntry {
                    path: f.get("path")?.as_str()?.to_string(),
                    size: f.get("size")?.as_u64()?,
                    sha256: f.get("sha256")?.as_str()?.to_string(),
                })
            })
            .collect()
    }

    pub fn entry(&self, path: &str) -> Option<FileEntry> {
        self.files().into_iter().find(|f| f.path == path)
    }

    pub fn removed(&self) -> Vec<String> {
        self.0.get("removed").and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
    }

    pub fn proxies(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        if let Some(Value::Object(m)) = self.0.get("proxies") {
            for (k, v) in m {
                if let Some(v) = v.as_str() {
                    out.insert(k.clone(), v.to_string());
                }
            }
        }
        out
    }

    pub fn set_archive(&mut self, dir: &Path, at: &str, files: &[FileEntry]) {
        let files: Vec<Value> = files.iter().map(FileEntry::to_json).collect();
        // Keep unknown keys of an earlier archive object.
        let mut a = match self.0.remove("archive") {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        a.insert("dir".into(), Value::String(dir.to_string_lossy().into_owned()));
        a.insert("at".into(), Value::String(at.into()));
        a.insert("files".into(), Value::Array(files));
        self.0.insert("archive".into(), Value::Object(a));
    }

    pub fn set_proxy(&mut self, raw: &str, proxy: &str) {
        let entry = self.0.entry("proxies").or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        entry.as_object_mut().unwrap().insert(raw.into(), Value::String(proxy.into()));
    }

    pub fn set_removed(&mut self, removed: &[String], at: Option<&str>) {
        if removed.is_empty() {
            self.0.remove("removed");
            self.0.remove("removedAt");
        } else {
            self.0.insert("removed".into(), json!(removed));
            if let Some(at) = at {
                self.0.insert("removedAt".into(), Value::String(at.into()));
            }
        }
    }

    /// The Home badge: "archived", "rawRemoved" or none.
    pub fn label(&self) -> Option<&'static str> {
        if !self.removed().is_empty() {
            Some("rawRemoved")
        } else if self.archive_dir().is_some() {
            Some("archived")
        } else {
            None
        }
    }
}

/// Size and SHA-256 (hex) of a file.
pub fn hash_file(path: &Path, progress: &mut dyn FnMut(u64)) -> io::Result<(u64, String)> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; BUF];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        size += n as u64;
        progress(n as u64);
    }
    Ok((size, hex(&h.finalize())))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// Every file to archive, relative with forward slashes, sorted. Skips `cache/`, `proxies/`,
/// `archive.json`, temp and part files, and anything that is a link.
pub fn archive_files(dir: &Path) -> io::Result<Vec<String>> {
    fn walk(root: &Path, rel: &str, out: &mut Vec<String>) -> io::Result<()> {
        let here = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        for e in fs::read_dir(&here)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = fs::symlink_metadata(e.path())?;
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if meta.is_dir() {
                if rel.is_empty() && SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                walk(root, &path, out)?;
            } else if meta.is_file() {
                let lower = name.to_ascii_lowercase();
                if (rel.is_empty() && name == STATE_FILE) || lower.ends_with(".tmp") || lower.ends_with(".part") {
                    continue;
                }
                out.push(path);
            }
        }
        Ok(())
    }
    let mut out = vec![];
    walk(dir, "", &mut out)?;
    out.sort();
    Ok(out)
}

/// Copy `src` to `dst` and prove the copy: hash while copying into `dst.part`, sync, rename, read
/// the copy back and hash it again. A `dst` that already has the same size and hash is left alone.
/// Returns the source's size and hash. A mismatch removes the bad copy and fails.
pub fn copy_verified(src: &Path, dst: &Path, progress: &mut dyn FnMut(u64)) -> Result<(u64, String), String> {
    let src_size = fs::metadata(src).map_err(err)?.len();
    if fs::metadata(dst).is_ok_and(|m| m.is_file() && m.len() == src_size) {
        let (_, a) = hash_file(src, progress).map_err(err)?;
        let (_, b) = hash_file(dst, &mut |_| {}).map_err(err)?;
        if a == b {
            return Ok((src_size, a));
        }
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let part = part_path(dst);
    let copied = (|| -> io::Result<(u64, String)> {
        let mut r = fs::File::open(src)?;
        let mut w = fs::File::create(&part)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; BUF];
        let mut size = 0u64;
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            w.write_all(&buf[..n])?;
            size += n as u64;
            progress(n as u64);
        }
        w.sync_all()?;
        drop(w);
        if dst.exists() {
            fs::remove_file(dst)?;
        }
        fs::rename(&part, dst)?;
        Ok((size, hex(&h.finalize())))
    })();
    let (size, hash) = match copied {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(format!("Could not copy {}. {e}", file_label(src)));
        }
    };
    let (back_size, back) = hash_file(dst, &mut |_| {}).map_err(err)?;
    if back_size != size || back != hash {
        let _ = fs::remove_file(dst);
        return Err(format!("The copy of {} does not match the original.", file_label(src)));
    }
    Ok((size, hash))
}

fn part_path(p: &Path) -> PathBuf {
    let mut s: OsString = p.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn file_label(p: &Path) -> String {
    p.file_name().map_or_else(|| p.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

fn project_id(dir: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&fs::read_to_string(dir.join("project.json")).ok()?).ok()?;
    v.get("id")?.as_str().map(str::to_string)
}

/// Where a project goes inside the archive root: `<root>/<folder>`, reused when it holds the same
/// project (same `id`), else `<name> (2).marz`, `<name> (3).marz` and so on.
pub fn target_dir(root: &Path, folder: &str, id: Option<&str>) -> PathBuf {
    let stem = folder.strip_suffix(".marz").unwrap_or(folder);
    for n in 1.. {
        let name = if n == 1 { format!("{stem}.marz") } else { format!("{stem} ({n}).marz") };
        let cand = root.join(name);
        if !cand.exists() {
            return cand;
        }
        if is_real_dir(&cand) && id.is_some() && project_id(&cand).as_deref() == id {
            return cand;
        }
    }
    unreachable!()
}

/// Progress of one step, 0 to 1.
pub type Report<'a> = &'a mut dyn FnMut(&str, f64);

/// Copy the project into the archive and record the manifest. While raw files are removed, archive
/// again goes to the same archive folder and keeps their entries (they are only there).
pub fn archive_into(dir: &Path, root: &Path, report: Report) -> Result<ArchiveState, String> {
    if dir.join(marz_capture::project::CRASH_MARKER).exists() {
        return Err("Recover this recording before you archive it.".into());
    }
    let mut state = ArchiveState::read(dir);
    let removed = state.removed();
    let target = match state.archive_dir() {
        Some(prev) if !removed.is_empty() => prev,
        _ => {
            let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Project.marz".into());
            target_dir(root, &folder, project_id(dir).as_deref())
        }
    };
    if target.starts_with(dir) || dir.starts_with(&target) {
        return Err("Pick an archive folder outside the project.".into());
    }
    fs::create_dir_all(&target).map_err(|e| format!("Could not make the archive folder. {e}"))?;
    let files = archive_files(dir).map_err(err)?;
    let total: u64 = files.iter().filter_map(|f| fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum::<u64>().max(1);
    let mut done = 0u64;
    let mut entries = vec![];
    for f in &files {
        let (size, sha256) = copy_verified(&dir.join(f), &target.join(f), &mut |n| {
            done += n;
            report("copying", done as f64 / total as f64);
        })?;
        entries.push(FileEntry { path: f.clone(), size, sha256 });
    }
    for r in &removed {
        if !entries.iter().any(|e| &e.path == r) {
            if let Some(e) = state.entry(r) {
                entries.push(e);
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    state.set_archive(&target, &iso_utc_now(), &entries);
    state.write(dir).map_err(err)?;
    report("copying", 1.0);
    Ok(state)
}

/// The raw video files of a project (`tracks.screen.file`, `tracks.camera.file`): plain names only.
pub fn raw_video_files(dir: &Path) -> Vec<String> {
    let Some(doc) = fs::read_to_string(dir.join("project.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return vec![];
    };
    ["screen", "camera"]
        .iter()
        .filter_map(|t| doc["tracks"][t]["file"].as_str())
        .filter(|f| is_plain_name(f))
        .map(str::to_string)
        .collect()
}

fn is_plain_name(f: &str) -> bool {
    !f.is_empty() && f != "." && f != ".." && !f.contains(['/', '\\', ':'])
}

/// Prove the archive still holds `files` exactly, and that the local files are the archived ones.
pub fn verify_archive(dir: &Path, state: &ArchiveState, files: &[String], report: Report) -> Result<(), String> {
    let Some(target) = state.archive_dir() else { return Err("Archive this project first.".into()) };
    let total: u64 = files.iter().filter_map(|f| state.entry(f)).map(|e| e.size * 2).sum::<u64>().max(1);
    let mut done = 0u64;
    for f in files {
        let Some(e) = state.entry(f) else { return Err(format!("{f} is not in the archive. Archive again first.")) };
        for (side, path) in [("here", dir.join(f)), ("in the archive", target.join(f))] {
            let (size, hash) = hash_file(&path, &mut |n| {
                done += n;
                report("checking", done as f64 / total as f64);
            })
            .map_err(|x| format!("Could not read {f} {side}. {x}"))?;
            if size != e.size || hash != e.sha256 {
                return Err(format!("{f} {side} does not match the archive record. Archive again first."));
            }
        }
    }
    Ok(())
}

/// Copy the removed raw files back from the archive, each checked against its recorded hash.
pub fn restore_from_archive(dir: &Path, report: Report) -> Result<ArchiveState, String> {
    let mut state = ArchiveState::read(dir);
    let removed = state.removed();
    if removed.is_empty() {
        return Ok(state);
    }
    let Some(target) = state.archive_dir() else { return Err("This project has no archive to restore from.".into()) };
    let total: u64 = removed.iter().filter_map(|f| state.entry(f)).map(|e| e.size).sum::<u64>().max(1);
    let mut done = 0u64;
    for f in &removed {
        let e = state.entry(f).ok_or_else(|| format!("{f} is not in the archive record."))?;
        let src = target.join(f);
        if !src.is_file() {
            return Err(format!("{f} is not in {}. If Google Drive is still downloading it, wait and try again.", target.display()));
        }
        let dst = dir.join(f);
        let part = part_path(&dst);
        let (size, hash) = copy_verified(&src, &part, &mut |n| {
            done += n;
            report("restoring", done as f64 / total as f64);
        })?;
        if size != e.size || hash != e.sha256 {
            let _ = fs::remove_file(&part);
            return Err(format!("The archive copy of {f} does not match the record. If Google Drive is still downloading it, wait and try again."));
        }
        fs::rename(&part, &dst).map_err(err)?;
    }
    state.set_removed(&[], None);
    state.write(dir).map_err(err)?;
    report("restoring", 1.0);
    Ok(state)
}

/// FFmpeg arguments for a proxy: at most 720 lines, H.264 CRF 30, no B-frames, a keyframe every
/// 2 s, frame times kept as they are, no audio, index at the front.
pub fn proxy_args(input: &Path, output: &Path, fps: u32) -> Vec<OsString> {
    let gop = (fps.max(1) * 2).to_string();
    let mut a: Vec<OsString> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-i"].iter().map(OsString::from).collect();
    a.push(input.as_os_str().to_owned());
    for s in [
        "-map", "0:v:0", "-an", "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        "-bf", "0", "-g", &gop, "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-movflags", "+faststart", "-f", "mp4",
    ] {
        a.push(s.into());
    }
    a.push(output.as_os_str().to_owned());
    a
}

fn probe_video(ffprobe: &Path, file: &Path) -> Result<(f64, u32), String> {
    let out = marz_export::tools::command(ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate:format=duration", "-of", "json"])
        .arg(file)
        .output()
        .map_err(err)?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("Could not read {}.", file_label(file)))?;
    let dur = v["format"]["duration"].as_str().and_then(|s| s.parse::<f64>().ok()).ok_or_else(|| format!("Could not read the length of {}.", file_label(file)))?;
    let fps = v["streams"][0]["r_frame_rate"].as_str().and_then(|r| {
        let (n, d) = r.split_once('/')?;
        let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
        (d > 0.0).then(|| (n / d).round() as u32)
    });
    Ok((dur, fps.unwrap_or(30)))
}

/// Make the proxy of `raw` at `out` (through `out.part`), then check its length.
fn make_proxy(ffmpeg: &Path, ffprobe: &Path, raw: &Path, out: &Path, report: &mut dyn FnMut(f64)) -> Result<(), String> {
    let (dur, fps) = probe_video(ffprobe, raw)?;
    if let Some(p) = out.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    let part = part_path(out);
    let mut child = marz_export::tools::command(ffmpeg)
        .args(proxy_args(raw, &part, fps))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start FFmpeg. {e}"))?;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                report((us / 1e6 / dur.max(0.001)).clamp(0.0, 1.0));
            }
        }
    }
    let output = child.wait_with_output().map_err(err)?;
    if !output.status.success() {
        let _ = fs::remove_file(&part);
        eprintln!("proxy ffmpeg: {}", String::from_utf8_lossy(&output.stderr));
        return Err(format!("FFmpeg could not make the proxy of {}.", file_label(raw)));
    }
    let (pdur, _) = probe_video(ffprobe, &part)?;
    if (pdur - dur).abs() > 0.5 {
        let _ = fs::remove_file(&part);
        return Err(format!("The proxy of {} is {pdur:.1} s long, the original {dur:.1} s.", file_label(raw)));
    }
    if out.exists() {
        fs::remove_file(out).map_err(err)?;
    }
    fs::rename(&part, out).map_err(err)
}

/// Proxies for every raw video file that has none yet. Returns the updated state.
pub fn ensure_proxies(dir: &Path, files: &[String], report: Report) -> Result<ArchiveState, String> {
    let mut state = ArchiveState::read(dir);
    let have = state.proxies();
    let todo: Vec<&String> = files.iter().filter(|f| !have.get(*f).is_some_and(|p| dir.join(p).is_file())).collect();
    if todo.is_empty() {
        return Ok(state);
    }
    let ffmpeg = marz_export::tools::find_ffmpeg().map_err(|_| "FFmpeg is missing. Install it or set MARZ_FFMPEG.".to_string())?;
    let ffprobe = marz_export::tools::find_ffprobe().map_err(|_| "ffprobe is missing. Install FFmpeg.".to_string())?;
    let n = todo.len() as f64;
    for (i, f) in todo.iter().enumerate() {
        let proxy = format!("{PROXY_DIR}/{f}");
        make_proxy(&ffmpeg, &ffprobe, &dir.join(f), &dir.join(&proxy), &mut |p| report("proxies", (i as f64 + p) / n))?;
        state.set_proxy(f, &proxy);
        state.write(dir).map_err(err)?;
    }
    report("proxies", 1.0);
    Ok(state)
}

/// `X:\My Drive` on any drive letter, or a Drive folder in the user folder: the first that exists,
/// with `Marz Recorder` added. `candidates` come from `drive_candidates`.
pub fn suggest_drive_root(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|c| c.is_dir()).map(|c| c.join("Marz Recorder"))
}

fn drive_candidates() -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = (b'C'..=b'Z').map(|l| PathBuf::from(format!("{}:\\My Drive", l as char))).collect();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        c.push(home.join("My Drive"));
        c.push(home.join("Google Drive").join("My Drive"));
        c.push(home.join("Google Drive"));
    }
    c
}

// ---------- Tauri commands ----------

/// One storage job at a time (copying, checking, proxies, restoring).
#[derive(Default)]
pub struct StorageJob(Mutex<Option<PathBuf>>);

struct JobGuard<'a>(&'a StorageJob);
impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut g) = self.0.0.lock() {
            *g = None;
        }
    }
}

fn start_job<'a>(job: &'a StorageJob, dir: &Path) -> Result<JobGuard<'a>, String> {
    let mut g = job.0.lock().map_err(err)?;
    if g.is_some() {
        return Err("Another archive step is running. Wait for it to finish.".into());
    }
    *g = Some(dir.to_path_buf());
    Ok(JobGuard(job))
}

#[derive(Serialize, Clone)]
struct ProgressMsg<'a> {
    dir: &'a str,
    step: &'a str,
    pct: f64,
}

fn reporter<'a>(app: &'a AppHandle, dir: &'a str) -> impl FnMut(&str, f64) + 'a {
    let mut last = (String::new(), -1.0f64);
    move |step: &str, pct: f64| {
        // At most one event per whole percent.
        let whole = (pct * 100.0).floor();
        if last.0 != step || whole != last.1 {
            last = (step.to_string(), whole);
            let _ = app.emit("archive://progress", ProgressMsg { dir, step, pct });
        }
    }
}

/// What Home and the editor show for a project's storage.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    pub label: Option<&'static str>,
    pub archive_dir: Option<String>,
    pub archived_at: Option<String>,
    /// The raw video files here now, by name, and their total size.
    pub raw_files: Vec<String>,
    pub raw_bytes: u64,
    pub removed: Vec<String>,
    pub uses_proxies: bool,
}

pub fn storage_view(dir: &Path) -> StorageView {
    let state = ArchiveState::read(dir);
    let raw: Vec<String> = raw_video_files(dir).into_iter().filter(|f| dir.join(f).is_file()).collect();
    let raw_bytes = raw.iter().filter_map(|f| fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum();
    let proxies = state.proxies();
    let removed = state.removed();
    StorageView {
        label: state.label(),
        archive_dir: state.archive_dir().map(|p| p.to_string_lossy().into_owned()),
        archived_at: state.archived_at(),
        raw_files: raw,
        raw_bytes,
        uses_proxies: removed.iter().any(|f| proxies.get(f).is_some_and(|p| dir.join(p).is_file())),
        removed,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(SETTINGS_FILE))
}

fn saved_dest(app: &AppHandle) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(&fs::read_to_string(settings_path(app).ok()?).ok()?).ok()?;
    v["dest"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
}

fn save_dest(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let text = json!({ "dest": dest.to_string_lossy() }).to_string();
    fs::write(settings_path(app)?, text).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSettings {
    pub(crate) dest: Option<String>,
    pub(crate) suggested: Option<String>,
}

#[tauri::command(async)]
pub fn archive_settings(app: AppHandle) -> ArchiveSettings {
    ArchiveSettings {
        dest: saved_dest(&app).map(|p| p.to_string_lossy().into_owned()),
        suggested: suggest_drive_root(&drive_candidates()).map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Folder dialog for the archive folder. Saved for next time. None when cancelled.
#[tauri::command(async)]
pub fn pick_archive_dest(app: AppHandle, window: WebviewWindow) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Pick the archive folder").set_parent(&window);
    if let Some(start) = saved_dest(&app).or_else(|| suggest_drive_root(&drive_candidates())).and_then(|p| p.parent().map(Path::to_path_buf)) {
        dialog = dialog.set_directory(start);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(None) };
    let dir = picked.into_path().map_err(err)?;
    if crate::projects::is_project_folder(&dir) {
        return Err("Pick a folder that is not a project.".into());
    }
    save_dest(&app, &dir)?;
    Ok(Some(dir.to_string_lossy().into_owned()))
}

/// Use the suggested Google Drive folder as the archive folder.
#[tauri::command(async)]
pub fn use_suggested_dest(app: AppHandle) -> Result<String, String> {
    let dest = suggest_drive_root(&drive_candidates()).ok_or("No Google Drive folder was found. Pick a folder.")?;
    save_dest(&app, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn project_storage(allowed: TauriState<'_, Allowed>, dir: String) -> Result<StorageView, String> {
    Ok(storage_view(&checked(&allowed, &dir)?))
}

#[tauri::command(async)]
pub fn archive_project(app: AppHandle, allowed: TauriState<'_, Allowed>, job: TauriState<'_, StorageJob>, dir: String) -> Result<StorageView, String> {
    let path = checked(&allowed, &dir)?;
    let root = saved_dest(&app).ok_or("Pick an archive folder first.")?;
    let _guard = start_job(&job, &path)?;
    let mut report = reporter(&app, &dir);
    archive_into(&path, &root, &mut report)?;
    Ok(storage_view(&path))
}

/// Proxies, then a fresh check of the archive, then the raw video files to the Recycle Bin.
#[tauri::command(async)]
pub fn remove_raw_files(app: AppHandle, window: WebviewWindow, allowed: TauriState<'_, Allowed>, job: TauriState<'_, StorageJob>, dir: String) -> Result<StorageView, String> {
    let path = checked(&allowed, &dir)?;
    let _guard = start_job(&job, &path)?;
    let mut report = reporter(&app, &dir);
    let files: Vec<String> = raw_video_files(&path).into_iter().filter(|f| path.join(f).is_file()).collect();
    if files.is_empty() {
        return Ok(storage_view(&path));
    }
    ensure_proxies(&path, &files, &mut report)?;
    let state = ArchiveState::read(&path);
    verify_archive(&path, &state, &files, &mut report)?;
    report("removing", 0.0);
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let mut removed = state.removed();
    let mut state = state;
    for f in &files {
        crate::projects::recycle::to_recycle_bin(&path.join(f), owner).map_err(|e| format!("Could not move {f} to the Recycle Bin. {e}"))?;
        if !removed.contains(f) {
            removed.push(f.clone());
        }
        state.set_removed(&removed, Some(&iso_utc_now()));
        state.write(&path).map_err(err)?;
    }
    report("removing", 1.0);
    Ok(storage_view(&path))
}

#[tauri::command(async)]
pub fn restore_raw_files(app: AppHandle, allowed: TauriState<'_, Allowed>, job: TauriState<'_, StorageJob>, dir: String) -> Result<StorageView, String> {
    let path = checked(&allowed, &dir)?;
    let _guard = start_job(&job, &path)?;
    let mut report = reporter(&app, &dir);
    restore_from_archive(&path, &mut report)?;
    Ok(storage_view(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-archive-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project(root: &Path, folder: &str, id: &str) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(dir.join("cache")).unwrap();
        fs::create_dir_all(dir.join("proxies")).unwrap();
        let doc = json!({ "id": id, "name": "P", "tracks": { "screen": { "file": "screen.mp4", "offsetUs": 0 }, "camera": { "file": "camera.mp4", "offsetUs": 0 }, "mic": { "file": "mic.wav" } } });
        fs::write(dir.join("project.json"), doc.to_string()).unwrap();
        fs::write(dir.join("screen.mp4"), vec![7u8; 3 * BUF + 17]).unwrap();
        fs::write(dir.join("camera.mp4"), b"camera").unwrap();
        fs::write(dir.join("mic.wav"), b"mic").unwrap();
        fs::write(dir.join("events.jsonl"), b"{}\n").unwrap();
        fs::write(dir.join("cache").join("mic.clean.wav"), b"derived").unwrap();
        fs::write(dir.join("proxies").join("screen.mp4"), b"proxy").unwrap();
        fs::write(dir.join("project.json.tmp"), b"half").unwrap();
        dir
    }

    fn quiet() -> impl FnMut(&str, f64) {
        |_: &str, _: f64| {}
    }

    #[test]
    fn hash_matches_the_sha256_test_vector() {
        let root = temp_dir("hash");
        fs::write(root.join("abc"), b"abc").unwrap();
        let (size, h) = hash_file(&root.join("abc"), &mut |_| {}).unwrap();
        assert_eq!(size, 3);
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn archive_files_skip_derived_and_temp_files() {
        let root = temp_dir("list");
        let dir = project(&root, "a.marz", "id-a");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("x.txt"), b"x").unwrap();
        fs::write(dir.join(STATE_FILE), b"{}").unwrap();
        fs::write(dir.join("screen.mp4.part"), b"p").unwrap();
        assert_eq!(archive_files(&dir).unwrap(), ["camera.mp4", "events.jsonl", "mic.wav", "project.json", "screen.mp4", "sub/x.txt"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn target_reuses_the_same_project_and_numbers_another() {
        let root = temp_dir("target");
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();
        assert_eq!(target_dir(&dest, "A.marz", Some("x")), dest.join("A.marz"));
        project(&dest, "A.marz", "x");
        assert_eq!(target_dir(&dest, "A.marz", Some("x")), dest.join("A.marz"));
        assert_eq!(target_dir(&dest, "A.marz", Some("other")), dest.join("A (2).marz"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn archive_copies_every_file_and_records_size_and_hash() {
        let root = temp_dir("archive");
        let dir = project(&root, "Take.marz", "id-1");
        let dest = root.join("Drive");
        let mut last = 0.0;
        let state = archive_into(&dir, &dest, &mut |_, p| last = p).unwrap();
        assert_eq!(last, 1.0);
        let target = dest.join("Take.marz");
        assert_eq!(state.archive_dir().unwrap(), target);
        let files = state.files();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["camera.mp4", "events.jsonl", "mic.wav", "project.json", "screen.mp4"]);
        for f in &files {
            assert_eq!(fs::read(target.join(&f.path)).unwrap(), fs::read(dir.join(&f.path)).unwrap());
            assert_eq!(hash_file(&target.join(&f.path), &mut |_| {}).unwrap(), (f.size, f.sha256.clone()));
        }
        assert!(!target.join("cache").exists() && !target.join("proxies").exists());
        // The state is saved in the project folder, nothing else changed there.
        assert_eq!(ArchiveState::read(&dir).label(), Some("archived"));
        assert_eq!(fs::read(dir.join("screen.mp4")).unwrap().len(), 3 * BUF + 17);
        // Archiving again updates the same folder.
        fs::write(dir.join("project.json"), json!({ "id": "id-1", "name": "Renamed" }).to_string()).unwrap();
        let again = archive_into(&dir, &dest, &mut quiet()).unwrap();
        assert_eq!(again.archive_dir().unwrap(), target);
        assert!(fs::read_to_string(target.join("project.json")).unwrap().contains("Renamed"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_verified_replaces_a_different_copy_and_leaves_no_part_file() {
        let root = temp_dir("copy");
        fs::write(root.join("a"), b"hello").unwrap();
        fs::write(root.join("b"), b"jello").unwrap();
        let (size, h) = copy_verified(&root.join("a"), &root.join("b"), &mut |_| {}).unwrap();
        assert_eq!(size, 5);
        assert_eq!(fs::read(root.join("b")).unwrap(), b"hello");
        assert_eq!(hash_file(&root.join("b"), &mut |_| {}).unwrap().1, h);
        assert!(!root.join("b.part").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_recording_that_needs_recovery_is_not_archived() {
        let root = temp_dir("crash");
        let dir = project(&root, "c.marz", "c");
        fs::write(dir.join(marz_capture::project::CRASH_MARKER), b"{}").unwrap();
        assert!(archive_into(&dir, &root.join("dest"), &mut quiet()).is_err());
        assert!(!root.join("dest").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn verify_fails_when_the_archive_copy_changed() {
        let root = temp_dir("verify");
        let dir = project(&root, "v.marz", "v");
        let state = archive_into(&dir, &root.join("dest"), &mut quiet()).unwrap();
        let files = raw_video_files(&dir);
        assert_eq!(files, ["screen.mp4", "camera.mp4"]);
        verify_archive(&dir, &state, &files, &mut quiet()).unwrap();
        fs::write(root.join("dest").join("v.marz").join("camera.mp4"), b"camerX").unwrap();
        let e = verify_archive(&dir, &state, &files, &mut quiet()).unwrap_err();
        assert!(e.contains("camera.mp4 in the archive"), "{e}");
        assert!(verify_archive(&dir, &ArchiveState::default(), &files, &mut quiet()).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    /// Remove by hand (the Recycle Bin needs Windows and a window), then restore.
    #[test]
    fn restore_copies_removed_files_back_and_checks_them() {
        let root = temp_dir("restore");
        let dir = project(&root, "r.marz", "r");
        let mut state = archive_into(&dir, &root.join("dest"), &mut quiet()).unwrap();
        let original = fs::read(dir.join("screen.mp4")).unwrap();
        fs::remove_file(dir.join("screen.mp4")).unwrap();
        state.set_removed(&["screen.mp4".into()], Some("t"));
        state.write(&dir).unwrap();
        assert_eq!(ArchiveState::read(&dir).label(), Some("rawRemoved"));
        // Archive again while removed: same folder, the removed file keeps its entry.
        let again = archive_into(&dir, &root.join("elsewhere"), &mut quiet()).unwrap();
        assert_eq!(again.archive_dir().unwrap(), root.join("dest").join("r.marz"));
        assert!(again.entry("screen.mp4").is_some());
        let restored = restore_from_archive(&dir, &mut quiet()).unwrap();
        assert_eq!(fs::read(dir.join("screen.mp4")).unwrap(), original);
        assert!(restored.removed().is_empty());
        assert_eq!(restored.label(), Some("archived"));
        assert!(!dir.join("screen.mp4.part").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_refuses_a_changed_archive_copy() {
        let root = temp_dir("restorebad");
        let dir = project(&root, "b.marz", "b");
        let mut state = archive_into(&dir, &root.join("dest"), &mut quiet()).unwrap();
        fs::remove_file(dir.join("camera.mp4")).unwrap();
        state.set_removed(&["camera.mp4".into()], Some("t"));
        state.write(&dir).unwrap();
        fs::write(root.join("dest").join("b.marz").join("camera.mp4"), b"other!").unwrap();
        assert!(restore_from_archive(&dir, &mut quiet()).is_err());
        assert!(!dir.join("camera.mp4").exists());
        assert!(!dir.join("camera.mp4.part").exists());
        assert_eq!(ArchiveState::read(&dir).removed(), ["camera.mp4"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn state_keeps_unknown_keys() {
        let root = temp_dir("state");
        fs::write(root.join(STATE_FILE), r#"{"later":1,"archive":{"dir":"D:/a","files":[],"extra":2}}"#).unwrap();
        let mut s = ArchiveState::read(&root);
        s.set_proxy("screen.mp4", "proxies/screen.mp4");
        s.set_archive(Path::new("D:/b"), "t", &[]);
        s.write(&root).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(root.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(v["later"], 1);
        assert_eq!(v["archive"]["extra"], 2);
        assert_eq!(v["proxies"]["screen.mp4"], "proxies/screen.mp4");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn drive_suggestion_takes_the_first_folder_that_exists() {
        let root = temp_dir("drive");
        let drive = root.join("G").join("My Drive");
        fs::create_dir_all(&drive).unwrap();
        assert_eq!(suggest_drive_root(&[root.join("F").join("My Drive"), drive.clone()]), Some(drive.join("Marz Recorder")));
        assert_eq!(suggest_drive_root(&[root.join("none")]), None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn proxy_args_keep_frame_times_and_drop_b_frames() {
        let a: Vec<String> = proxy_args(Path::new("in.mp4"), Path::new("out.mp4"), 60).into_iter().map(|s| s.to_string_lossy().into_owned()).collect();
        let s = a.join(" ");
        for want in ["-bf 0", "-g 120", "-fps_mode passthrough", "-an", "-movflags +faststart", "scale=-2:'min(720,ih)'"] {
            assert!(s.contains(want), "{want} missing in {s}");
        }
        assert_eq!(a.last().unwrap(), "out.mp4");
    }

    #[test]
    fn storage_view_reports_raw_files_and_proxies() {
        let root = temp_dir("view");
        let dir = project(&root, "s.marz", "s");
        let v = storage_view(&dir);
        assert_eq!((v.label, v.raw_files.clone(), v.raw_bytes, v.uses_proxies), (None, vec!["screen.mp4".to_string(), "camera.mp4".into()], (3 * BUF + 17 + 6) as u64, false));
        let mut s = ArchiveState::default();
        s.set_proxy("screen.mp4", "proxies/screen.mp4");
        s.set_removed(&["screen.mp4".into()], Some("t"));
        s.write(&dir).unwrap();
        fs::remove_file(dir.join("screen.mp4")).unwrap();
        let v = storage_view(&dir);
        assert_eq!((v.label, v.raw_files, v.uses_proxies), (Some("rawRemoved"), vec!["camera.mp4".to_string()], true));
        fs::remove_dir_all(&root).unwrap();
    }
}
