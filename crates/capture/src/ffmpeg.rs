//! FFmpeg sidecar for the screen track: lookup, encoder probe, argument builder and the piped encoder.

use crate::CaptureError;
use crate::slots::FrameSink;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::thread::JoinHandle;

const STDERR_LINES: usize = 20;

// The lookup and the no-console `command` helper live in marz-export (one copy, shared with the
// exporter). The wrappers keep this module's `CaptureError` signatures for every caller.
pub use marz_export::tools::command;

impl From<marz_export::tools::ToolNotFound> for CaptureError {
    fn from(_: marz_export::tools::ToolNotFound) -> Self {
        CaptureError::NoFfmpeg
    }
}

/// Look up `ffmpeg`: `MARZ_FFMPEG`, then beside the running exe, then PATH.
pub fn find_ffmpeg() -> Result<PathBuf, CaptureError> {
    Ok(marz_export::tools::find_ffmpeg()?)
}

/// Look up `ffprobe` with the same rules (`MARZ_FFPROBE` override).
pub fn find_ffprobe() -> Result<PathBuf, CaptureError> {
    Ok(marz_export::tools::find_ffprobe()?)
}

/// `find_ffmpeg` with its three inputs passed in, so tests need not touch the process environment.
pub fn find_ffmpeg_in(env_override: Option<&OsStr>, exe_dir: Option<&Path>, path_var: Option<&OsStr>) -> Result<PathBuf, CaptureError> {
    Ok(marz_export::tools::find_ffmpeg_in(env_override, exe_dir, path_var)?)
}

/// First of the hardware H.264 encoders that encodes one 256 x 256 BGRA frame, else `libx264`.
pub fn probe_encoder(ffmpeg: &Path) -> String {
    for enc in ["h264_nvenc", "h264_amf", "h264_qsv"] {
        let ok = command(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30,format=bgra", "-frames:v", "1", "-c:v", enc, "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return enc.to_string();
        }
    }
    "libx264".to_string()
}

/// FFmpeg arguments: raw BGRA frames on `pipe:0`, constant frame rate, fragmented MP4 so a crash
/// leaves a playable file.
pub fn screen_args(encoder: &str, w: u32, h: u32, fps: u32, out: &Path) -> Vec<String> {
    let size = format!("{w}x{h}");
    let fps_s = fps.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", &size, "-r", &fps_s, "-i", "pipe:0"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let enc_args: Vec<&str> = match encoder {
        "h264_nvenc" => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        "libx264" => vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
        other => vec!["-c:v", other],
    };
    args.extend(enc_args.iter().map(|s| s.to_string()));
    args.extend(
        ["-g", &fps_s, "-fps_mode", "cfr", "-r", &fps_s, "-movflags", "frag_keyframe+empty_moov+default_base_moof", &out.to_string_lossy()]
            .iter()
            .map(|s| s.to_string()),
    );
    args
}

/// A running FFmpeg process fed raw frames through its stdin.
pub struct ScreenEncoder {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Option<JoinHandle<VecDeque<String>>>,
}

impl ScreenEncoder {
    pub fn spawn(ffmpeg: &Path, args: &[String]) -> Result<Self, CaptureError> {
        let mut child = command(ffmpeg).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
        let stdin = child.stdin.take();
        // Drain stderr on its own thread so the pipe never fills and stalls FFmpeg; keep the tail.
        let stderr = child.stderr.take().map(|pipe| {
            std::thread::spawn(move || {
                let mut ring = VecDeque::with_capacity(STDERR_LINES);
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    if ring.len() == STDERR_LINES {
                        ring.pop_front();
                    }
                    ring.push_back(line);
                }
                ring
            })
        });
        Ok(Self { child, stdin, stderr })
    }

    /// The FFmpeg process id (for CPU measurements).
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Close stdin, wait for FFmpeg to finish the file, and map a non-zero exit to `Encoder`.
    pub fn finish(mut self) -> Result<(), CaptureError> {
        drop(self.stdin.take());
        let status = self.child.wait()?;
        let lines = self.stderr.take().and_then(|h| h.join().ok()).unwrap_or_default();
        if status.success() {
            Ok(())
        } else {
            let tail = lines.into_iter().collect::<Vec<_>>().join("\n");
            Err(CaptureError::Encoder(format!("ffmpeg exited with {status}: {tail}")))
        }
    }
}

impl FrameSink for ScreenEncoder {
    fn write(&mut self, frame: &[u8]) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(frame),
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "encoder stdin is closed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-ffmpeg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn args_contain_fragmented_flags() {
        let args = screen_args("h264_nvenc", 1920, 1080, 30, Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-movflags frag_keyframe+empty_moov+default_base_moof"), "{joined}");
        assert!(joined.contains("-f rawvideo -pix_fmt bgra -s 1920x1080 -r 30 -i pipe:0"), "{joined}");
        assert_eq!(args.last().unwrap(), "out.mp4");
        assert!(!joined.contains("yuv420p"), "hardware encoders take BGRA: {joined}");
    }

    #[test]
    fn libx264_gets_yuv420p() {
        let args = screen_args("libx264", 64, 64, 30, Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-c:v libx264 -preset veryfast"), "{joined}");
        assert!(joined.contains("-pix_fmt yuv420p"), "{joined}");
    }

    #[test]
    fn encodes_ten_frames() {
        let Ok(ffmpeg) = find_ffmpeg() else {
            eprintln!("skipped encodes_ten_frames: ffmpeg not found");
            return;
        };
        let Ok(ffprobe) = find_ffprobe() else {
            eprintln!("skipped encodes_ten_frames: ffprobe not found");
            return;
        };
        let dir = temp_dir("encode");
        let out = dir.join("out.mp4");
        let args = screen_args("libx264", 64, 64, 30, &out);
        let mut enc = ScreenEncoder::spawn(&ffmpeg, &args).unwrap();
        let frame = vec![128u8; 64 * 64 * 4];
        for _ in 0..10 {
            enc.write(&frame).unwrap();
        }
        enc.finish().unwrap();
        let probe = Command::new(&ffprobe)
            .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"])
            .arg(&out)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "10");
    }

    #[test]
    fn failing_encoder_reports_stderr() {
        let Ok(ffmpeg) = find_ffmpeg() else {
            eprintln!("skipped failing_encoder_reports_stderr: ffmpeg not found");
            return;
        };
        let dir = temp_dir("fail");
        let out = dir.join("no-such-dir").join("out.mp4");
        let args = screen_args("libx264", 64, 64, 30, &out);
        let mut enc = ScreenEncoder::spawn(&ffmpeg, &args).unwrap();
        let frame = vec![0u8; 64 * 64 * 4];
        let _ = enc.write(&frame);
        match enc.finish() {
            Err(CaptureError::Encoder(msg)) => assert!(!msg.is_empty()),
            other => panic!("expected Encoder error, got {other:?}"),
        }
    }

    #[test]
    fn probe_encoder_returns_a_known_encoder() {
        let Ok(ffmpeg) = find_ffmpeg() else {
            eprintln!("skipped probe_encoder: ffmpeg not found");
            return;
        };
        let enc = probe_encoder(&ffmpeg);
        assert!(["h264_nvenc", "h264_amf", "h264_qsv", "libx264"].contains(&enc.as_str()), "{enc}");
    }
}
