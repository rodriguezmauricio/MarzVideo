//! Home thumbnails: one small JPEG frame per project, made once with FFmpeg and cached in the
//! app cache folder (never inside the project, the raw tracks stay untouched).
//!
//! Home used to put a `<video>` per row on the page; WebView2 then read most of a long
//! fragmented `screen.mp4` (hundreds of MB) before it could show a frame, so long takes stayed
//! blank. A 192 px JPEG costs about 5 KB and a quarter of a second, once.

use crate::projects::{Allowed, checked};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};

/// Cache file name for a screen track: changes when the path, size or write time changes.
pub fn cache_key(screen: &Path, len: u64, modified_ms: u128) -> String {
    let mut h = DefaultHasher::new();
    screen.hash(&mut h);
    len.hash(&mut h);
    modified_ms.hash(&mut h);
    format!("{:016x}.jpg", h.finish())
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn make(ffmpeg: &Path, screen: &Path, out: &Path) -> Result<(), String> {
    let tmp = out.with_extension("part.jpg");
    let status = marz_export::tools::command(ffmpeg)
        .args(["-v", "error", "-y", "-ss", "0.5", "-i"])
        .arg(screen)
        .args(["-frames:v", "1", "-vf", "scale=192:-2", "-q:v", "4"])
        .arg(&tmp)
        .status()
        .map_err(|e| e.to_string())?;
    // A take shorter than half a second has no frame at 0.5 s: use the first frame.
    if !status.success() || !tmp.is_file() {
        let status = marz_export::tools::command(ffmpeg)
            .args(["-v", "error", "-y", "-i"])
            .arg(screen)
            .args(["-frames:v", "1", "-vf", "scale=192:-2", "-q:v", "4"])
            .arg(&tmp)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("FFmpeg could not read a frame".into());
        }
    }
    fs::rename(&tmp, out).map_err(|e| e.to_string())
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A `data:image/jpeg` URL of the project's screen track, or an error when there is none.
#[tauri::command(async)]
pub fn project_thumb(app: AppHandle, allowed: State<'_, Allowed>, dir: String) -> Result<String, String> {
    let dir = checked(&allowed, &dir)?;
    let screen = dir.join("screen.mp4");
    let meta = fs::metadata(&screen).map_err(|e| e.to_string())?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let out = cache_dir(&app)?.join(cache_key(&screen, meta.len(), modified));
    if !out.is_file() {
        let ffmpeg = marz_export::tools::find_ffmpeg().map_err(|e| e.to_string())?;
        make(&ffmpeg, &screen, &out)?;
    }
    let bytes = fs::read(&out).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn cache_key_changes_when_the_file_changes() {
        let p = Path::new("C:/x/a.marz/screen.mp4");
        let k = cache_key(p, 10, 5);
        assert_eq!(k, cache_key(p, 10, 5));
        assert_ne!(k, cache_key(p, 11, 5));
        assert_ne!(k, cache_key(p, 10, 6));
        assert_ne!(k, cache_key(Path::new("C:/x/b.marz/screen.mp4"), 10, 5));
        assert!(k.ends_with(".jpg"));
    }
}
