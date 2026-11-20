//! Saved looks (scene presets): `looks.json` in the app config folder, read and written whole.
//! The rules (names, default look, applying) live in `src/looks`; this only keeps the file
//! (design `docs/superpowers/specs/2026-11-19-scene-presets-design.md`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const FILE: &str = "looks.json";
/// A looks file is a few kilobytes; refuse anything absurd rather than fill the disk.
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn empty() -> Value {
    json!({ "version": 1, "looks": [], "default": null })
}

/// The stored file, or an empty one when it is missing, broken or not a JSON object.
pub fn read(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(empty)
}

/// Write the file (temp file, then rename, so a crash never leaves half a file).
pub fn write(path: &Path, v: &Value) -> io::Result<()> {
    if !v.is_object() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "looks must be a JSON object"));
    }
    let text = serde_json::to_string_pretty(v).map_err(io::Error::other)?;
    if text.len() > MAX_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "looks file too large"));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

static WRITE: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(FILE))
}

#[tauri::command(async)]
pub fn looks_get(app: AppHandle) -> Result<Value, String> {
    Ok(read(&path(&app)?))
}

#[tauri::command(async)]
pub fn looks_set(app: AppHandle, file: Value) -> Result<(), String> {
    let _g = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    write(&path(&app)?, &file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marz-looks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_or_broken_file_reads_empty() {
        let d = tmp("missing");
        assert_eq!(read(&d.join(FILE)), empty());
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE), "{not json").unwrap();
        assert_eq!(read(&d.join(FILE)), empty());
        fs::write(d.join(FILE), "[1,2]").unwrap();
        assert_eq!(read(&d.join(FILE)), empty());
    }

    #[test]
    fn round_trips_whole_file() {
        let d = tmp("round");
        let v = json!({ "version": 1, "looks": [{ "name": "Studio", "background": { "style": "glow", "blur": 3 } }], "default": null, "later": true });
        write(&d.join(FILE), &v).unwrap();
        assert_eq!(read(&d.join(FILE)), v);
        assert!(!d.join("looks.json.tmp").exists());
    }

    #[test]
    fn refuses_a_non_object() {
        let d = tmp("refuse");
        assert!(write(&d.join(FILE), &json!([1])).is_err());
        assert!(!d.join(FILE).exists());
    }
}
