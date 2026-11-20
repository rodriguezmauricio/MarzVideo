//! Background image (design `2026-11-19-background-image-blur-design.md`): the file dialog for a JPG or PNG,
//! copied into the project's `assets/` folder. The page never hands over a source path, and only a folder
//! Home allowed can receive the copy. Raw tracks are never touched.

use crate::projects::{checked, Allowed};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Largest image accepted (bytes).
pub const MAX_IMAGE_BYTES: u64 = 40 * 1024 * 1024;
pub const ASSETS_DIR: &str = "assets";

/// "jpg" or "png" from the file's first bytes, or None when it is neither.
pub fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else {
        None
    }
}

/// Copy `bytes` into `<dir>/assets/background-<first 8 hex of SHA-256>.<jpg|png>` and return the path relative
/// to `dir` with forward slashes. The same picture picked twice lands on the same name and is not rewritten.
pub fn store_image(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("This image is larger than 40 MB.".into());
    }
    let kind = image_kind(bytes).ok_or("Pick a JPG or PNG image.")?;
    let hash = Sha256::digest(bytes);
    let name = format!("background-{:02x}{:02x}{:02x}{:02x}.{kind}", hash[0], hash[1], hash[2], hash[3]);
    let assets = dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let target = assets.join(&name);
    if !target.is_file() || fs::metadata(&target).map(|m| m.len()).unwrap_or(0) != bytes.len() as u64 {
        let tmp = assets.join(format!("{name}.tmp"));
        let result = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, &target)
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    Ok(format!("{ASSETS_DIR}/{name}"))
}

/// File dialog for "Pick image". Returns the project-relative path, or None when cancelled.
#[tauri::command(async)]
pub fn pick_background_image(app: AppHandle, window: WebviewWindow, allowed: State<'_, Allowed>, dir: String) -> Result<Option<String>, String> {
    let dir = checked(&allowed, &dir)?;
    let picked = app
        .dialog()
        .file()
        .set_title("Pick a background image")
        .set_parent(&window)
        .add_filter("Image", &["jpg", "jpeg", "png"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let src = picked.into_path().map_err(|e| e.to_string())?;
    let len = fs::metadata(&src).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err("This image is larger than 40 MB.".into());
    }
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    store_image(&dir, &bytes).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marz-bg-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

    #[test]
    fn copies_into_assets_under_a_hash_name() {
        let d = temp_dir("copy");
        let rel = store_image(&d, &PNG).unwrap();
        assert!(rel.starts_with("assets/background-") && rel.ends_with(".png"), "{rel}");
        assert_eq!(rel.len(), "assets/background-00000000.png".len());
        assert_eq!(fs::read(d.join(&rel)).unwrap(), PNG);
        // Same picture again: same name, one file, no temp file left.
        assert_eq!(store_image(&d, &PNG).unwrap(), rel);
        assert_eq!(fs::read_dir(d.join(ASSETS_DIR)).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn jpeg_gets_jpg_and_other_files_are_refused() {
        let d = temp_dir("kind");
        assert!(store_image(&d, &[0xFF, 0xD8, 0xFF, 0xE0, 0]).unwrap().ends_with(".jpg"));
        assert!(store_image(&d, b"GIF89a....").is_err());
        assert!(store_image(&d, b"").is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
