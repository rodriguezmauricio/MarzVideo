//! Finding and spawning the FFmpeg tools. Shared by the recorder (marz-capture) and the exporter.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// ffmpeg or ffprobe was not found (or the override points nowhere).
#[derive(Debug, PartialEq, Eq)]
pub struct ToolNotFound;

impl fmt::Display for ToolNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ffmpeg was not found")
    }
}

impl std::error::Error for ToolNotFound {}

/// A `Command` that never opens a console window on Windows, so a GUI app does not flash one for
/// every FFmpeg or ffprobe spawn. Every production spawn goes through it.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn exe_name(base: &str) -> String {
    if cfg!(windows) { format!("{base}.exe") } else { base.to_string() }
}

/// Look up `ffmpeg`: `MARZ_FFMPEG`, then beside the running exe, then PATH.
pub fn find_ffmpeg() -> Result<PathBuf, ToolNotFound> {
    find_tool("ffmpeg", "MARZ_FFMPEG")
}

/// Look up `ffprobe` with the same rules (`MARZ_FFPROBE` override).
pub fn find_ffprobe() -> Result<PathBuf, ToolNotFound> {
    find_tool("ffprobe", "MARZ_FFPROBE")
}

fn find_tool(name: &str, env_key: &str) -> Result<PathBuf, ToolNotFound> {
    let env_override = std::env::var_os(env_key);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let path_var = std::env::var_os("PATH");
    find_tool_in(name, env_override.as_deref(), exe_dir.as_deref(), path_var.as_deref())
}

/// `find_ffmpeg` with its three inputs passed in, so tests need not touch the process environment.
pub fn find_ffmpeg_in(env_override: Option<&OsStr>, exe_dir: Option<&Path>, path_var: Option<&OsStr>) -> Result<PathBuf, ToolNotFound> {
    find_tool_in("ffmpeg", env_override, exe_dir, path_var)
}

fn find_tool_in(name: &str, env_override: Option<&OsStr>, exe_dir: Option<&Path>, path_var: Option<&OsStr>) -> Result<PathBuf, ToolNotFound> {
    if let Some(p) = env_override {
        let p = PathBuf::from(p);
        // A set override that points nowhere is an error, never a silent fall-through.
        return if p.is_file() { Ok(p) } else { Err(ToolNotFound) };
    }
    let file = exe_name(name);
    if let Some(dir) = exe_dir {
        let c = dir.join(&file);
        if c.is_file() {
            return Ok(c);
        }
    }
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let c = dir.join(&file);
            if c.is_file() {
                return Ok(c);
            }
        }
    }
    Err(ToolNotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-tools-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_ffmpeg_is_not_found() {
        let dir = temp_dir("missing");
        let missing = dir.join("nope.exe");
        let r = find_ffmpeg_in(Some(missing.as_os_str()), Some(&dir), Some(dir.as_os_str()));
        assert_eq!(r, Err(ToolNotFound));
        let r = find_ffmpeg_in(None, None, Some(std::ffi::OsStr::new("")));
        assert_eq!(r, Err(ToolNotFound));
        let r = find_ffmpeg_in(None, None, None);
        assert_eq!(r, Err(ToolNotFound));
    }

    #[test]
    fn env_override_wins_when_it_exists() {
        let dir = temp_dir("env");
        let fake = dir.join("custom-ffmpeg");
        std::fs::write(&fake, b"").unwrap();
        let beside = dir.join(exe_name("ffmpeg"));
        std::fs::write(&beside, b"").unwrap();
        let r = find_ffmpeg_in(Some(fake.as_os_str()), Some(&dir), None).unwrap();
        assert_eq!(r, fake);
    }

    #[test]
    fn exe_dir_beats_path() {
        let exe_dir = temp_dir("exedir");
        let path_dir = temp_dir("pathdir");
        std::fs::write(exe_dir.join(exe_name("ffmpeg")), b"").unwrap();
        std::fs::write(path_dir.join(exe_name("ffmpeg")), b"").unwrap();
        let r = find_ffmpeg_in(None, Some(&exe_dir), Some(path_dir.as_os_str())).unwrap();
        assert_eq!(r, exe_dir.join(exe_name("ffmpeg")));
    }

    #[test]
    fn path_search_finds_the_executable() {
        let a = temp_dir("path-a");
        let b = temp_dir("path-b");
        std::fs::write(b.join(exe_name("ffmpeg")), b"").unwrap();
        let joined: OsString = std::env::join_paths([&a, &b]).unwrap();
        let r = find_ffmpeg_in(None, None, Some(joined.as_os_str())).unwrap();
        assert_eq!(r, b.join(exe_name("ffmpeg")));
    }

    #[test]
    fn ffprobe_uses_the_same_rules() {
        let dir = temp_dir("probe");
        std::fs::write(dir.join(exe_name("ffprobe")), b"").unwrap();
        let r = find_tool_in("ffprobe", None, None, Some(dir.as_os_str())).unwrap();
        assert_eq!(r, dir.join(exe_name("ffprobe")));
    }
}
