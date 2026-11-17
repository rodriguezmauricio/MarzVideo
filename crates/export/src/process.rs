//! The running export: FFmpeg fed H.264 chunks on stdin, writing `<out>.part`, renamed on success.

use crate::ExportJob;
use crate::args::{ffmpeg_args, part_path};
use crate::tools::command;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::thread::JoinHandle;

const STDERR_LINES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub out_path: PathBuf,
    pub duration_us: i64,
    pub size_bytes: u64,
}

/// A running FFmpeg muxer. Feed it the encoded video with `write_chunk`, then `finish` or `cancel`.
/// Dropping it unfinished behaves like `cancel`.
pub struct ExportProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Option<JoinHandle<VecDeque<String>>>,
    out_path: PathBuf,
    part: PathBuf,
    duration_us: i64,
    done: bool,
}

impl ExportProcess {
    pub fn start(ffmpeg: &Path, job: ExportJob) -> io::Result<Self> {
        let part = part_path(&job.out_path);
        let mut child = command(ffmpeg).args(ffmpeg_args(&job)).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
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
        Ok(Self { child, stdin, stderr, out_path: job.out_path, part, duration_us: job.output_duration_us, done: false })
    }

    /// Send the next chunk of H.264 annexb. An error (usually a broken pipe) means FFmpeg exited;
    /// `finish` then returns its message.
    pub fn write_chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(bytes),
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "ffmpeg stdin is closed")),
        }
    }

    /// Close the video stream, wait for FFmpeg, then move `.part` to the final name (replacing an
    /// existing file: the save dialog already asked). On failure `.part` is deleted and the existing
    /// target is left as it was.
    pub fn finish(mut self) -> Result<ExportReport, String> {
        self.done = true;
        drop(self.stdin.take());
        let status = self.child.wait().map_err(|e| format!("could not wait for ffmpeg: {e}"))?;
        let lines = self.stderr.take().and_then(|h| h.join().ok()).unwrap_or_default();
        if !status.success() {
            let _ = std::fs::remove_file(&self.part);
            let tail = lines.into_iter().collect::<Vec<_>>().join("
");
            return Err(format!("ffmpeg exited with {status}: {tail}"));
        }
        if let Err(e) = std::fs::rename(&self.part, &self.out_path) {
            let _ = std::fs::remove_file(&self.part);
            return Err(format!("could not move the export into place: {e}"));
        }
        let size_bytes = std::fs::metadata(&self.out_path).map(|m| m.len()).map_err(|e| format!("could not read the export: {e}"))?;
        Ok(ExportReport { out_path: self.out_path.clone(), duration_us: self.duration_us, size_bytes })
    }

    /// Kill FFmpeg and delete `.part`. The existing target, if any, is untouched.
    pub fn cancel(mut self) {
        self.abort();
    }

    fn abort(&mut self) {
        self.done = true;
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(h) = self.stderr.take() {
            let _ = h.join();
        }
        let _ = std::fs::remove_file(&self.part);
    }
}

impl Drop for ExportProcess {
    fn drop(&mut self) {
        if !self.done {
            self.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{command, find_ffmpeg, find_ffprobe};
    use crate::{MicJob, Segment};
    use std::process::Stdio;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-export-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn part_of(p: &Path) -> PathBuf {
        let mut s = p.as_os_str().to_owned();
        s.push(".part");
        PathBuf::from(s)
    }

    /// A 2 s 30 fps H.264 annexb stream (returned) and a 3 s sine mic.wav (written), made by FFmpeg.
    fn fixtures(ffmpeg: &Path, dir: &Path) -> Vec<u8> {
        let out = command(ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let wav = dir.join("mic.wav");
        let st = command(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3"])
            .arg(&wav)
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert!(st.success());
        out.stdout
    }

    fn job(dir: &Path, mic: Option<MicJob>) -> ExportJob {
        ExportJob {
            project_dir: dir.to_path_buf(),
            out_path: dir.join("out.mp4"),
            width: 320,
            height: 180,
            fps: 30,
            // 1.2 s + 0.8 s = 2.0 s, matching the 2 s video stream.
            segments: vec![
                Segment { src_start_us: 0, src_end_us: 1_200_000, out_start_us: 0 },
                Segment { src_start_us: 1_500_000, src_end_us: 2_300_000, out_start_us: 1_200_000 },
            ],
            mic,
            output_duration_us: 2_000_000,
        }
    }

    fn mic(offset_us: i64) -> Option<MicJob> {
        Some(MicJob { file: "mic.wav".into(), offset_us, volume: 1.0, muted: false })
    }

    fn probe(ffprobe: &Path, file: &Path) -> (Vec<String>, f64) {
        let out = command(ffprobe)
            .args(["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "default=nw=1"])
            .arg(file)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let kinds = text.lines().filter_map(|l| l.strip_prefix("codec_type=")).map(str::to_string).collect();
        let dur = text.lines().find_map(|l| l.strip_prefix("duration=")).and_then(|d| d.parse().ok()).unwrap_or(-1.0);
        (kinds, dur)
    }

    /// Top-level MP4 box names in file order.
    fn boxes(file: &Path) -> Vec<String> {
        let b = std::fs::read(file).unwrap();
        let mut pos = 0usize;
        let mut names = Vec::new();
        while pos + 8 <= b.len() {
            let size = u32::from_be_bytes(b[pos..pos + 4].try_into().unwrap()) as usize;
            names.push(String::from_utf8_lossy(&b[pos + 4..pos + 8]).to_string());
            if size < 8 {
                break;
            }
            pos += size;
        }
        names
    }

    /// Loudest sample of the audio track in dB (volumedetect), so tests can tell sound from silence.
    fn max_volume_db(ffmpeg: &Path, file: &Path) -> f64 {
        let out = command(ffmpeg).args(["-hide_banner", "-nostats", "-i"]).arg(file).args(["-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
        let text = String::from_utf8_lossy(&out.stderr).to_string();
        let v = text.lines().find_map(|l| l.split("max_volume:").nth(1)).unwrap_or_else(|| panic!("no max_volume in {text}"));
        v.trim().trim_end_matches(" dB").parse().unwrap()
    }

    fn run(ffmpeg: &Path, ffprobe: &Path, tag: &str, mic_for: Option<MicJob>) -> PathBuf {
        let dir = temp_dir(tag);
        let h264 = fixtures(ffmpeg, &dir);
        let j = job(&dir, mic_for);
        let out = j.out_path.clone();
        let mut p = ExportProcess::start(ffmpeg, j).unwrap();
        for chunk in h264.chunks(4096) {
            p.write_chunk(chunk).unwrap();
        }
        let report = p.finish().unwrap();
        assert_eq!(report.out_path, out);
        assert_eq!(report.duration_us, 2_000_000);
        assert!(report.size_bytes > 0);
        assert!(out.is_file());
        assert!(!part_of(&out).exists(), ".part must be gone");
        let (kinds, dur) = probe(ffprobe, &out);
        assert!(kinds.contains(&"video".to_string()) && kinds.contains(&"audio".to_string()), "{kinds:?}");
        assert!((dur - 2.0).abs() <= 1.0 / 30.0, "duration {dur}");
        let names = boxes(&out);
        let moov = names.iter().position(|n| n == "moov").expect("moov");
        let mdat = names.iter().position(|n| n == "mdat").expect("mdat");
        assert!(moov < mdat, "faststart: {names:?}");
        out
    }

    macro_rules! tools_or_skip {
        ($name:literal) => {{
            let (Ok(ffmpeg), Ok(ffprobe)) = (find_ffmpeg(), find_ffprobe()) else {
                eprintln!(concat!("skipped ", $name, ": ffmpeg or ffprobe not found"));
                return;
            };
            (ffmpeg, ffprobe)
        }};
    }

    #[test]
    fn writes_to_part_then_renames() {
        let (ffmpeg, ffprobe) = tools_or_skip!("writes_to_part_then_renames");
        run(&ffmpeg, &ffprobe, "mic", mic(12_400));
    }

    #[test]
    fn mic_is_audible_and_muted_or_missing_is_silent() {
        let (ffmpeg, ffprobe) = tools_or_skip!("audible_vs_silent");
        let with_mic = run(&ffmpeg, &ffprobe, "loud", mic(12_400));
        assert!(max_volume_db(&ffmpeg, &with_mic) > -20.0);
        let late = run(&ffmpeg, &ffprobe, "loudlate", mic(1_000_000));
        assert!(max_volume_db(&ffmpeg, &late) > -20.0, "the part after the mic starts must be audible");
        let muted = run(&ffmpeg, &ffprobe, "quiet", Some(MicJob { file: "mic.wav".into(), offset_us: 0, volume: 1.0, muted: true }));
        assert!(max_volume_db(&ffmpeg, &muted) < -60.0);
        let none = run(&ffmpeg, &ffprobe, "quiet2", None);
        assert!(max_volume_db(&ffmpeg, &none) < -60.0);
        let after = run(&ffmpeg, &ffprobe, "quiet3", mic(2_600_000));
        assert!(max_volume_db(&ffmpeg, &after) < -60.0);
    }

    #[test]
    fn mic_starting_late_still_exports_full_length() {
        let (ffmpeg, ffprobe) = tools_or_skip!("mic_starting_late");
        // Offset 1.0 s: the first segment starts before the mic, so it is padded with silence.
        run(&ffmpeg, &ffprobe, "late", mic(1_000_000));
    }

    #[test]
    fn mic_starting_after_every_segment_is_all_silence() {
        let (ffmpeg, ffprobe) = tools_or_skip!("mic_after_every_segment");
        // Offset 2.6 s: both segments end before the mic starts, so only the silent branch is used.
        run(&ffmpeg, &ffprobe, "after", mic(2_600_000));
    }

    #[test]
    fn no_mic_still_has_an_audio_track() {
        let (ffmpeg, ffprobe) = tools_or_skip!("no_mic");
        run(&ffmpeg, &ffprobe, "nomic", None);
    }

    #[test]
    fn muted_mic_still_has_an_audio_track() {
        let (ffmpeg, ffprobe) = tools_or_skip!("muted");
        run(&ffmpeg, &ffprobe, "muted", Some(MicJob { file: "mic.wav".into(), offset_us: 0, volume: 1.0, muted: true }));
    }

    #[test]
    fn replaces_an_existing_target_on_success() {
        let (ffmpeg, _) = tools_or_skip!("replaces_existing");
        let dir = temp_dir("replace");
        let h264 = fixtures(&ffmpeg, &dir);
        let j = job(&dir, None);
        let out = j.out_path.clone();
        std::fs::write(&out, b"old").unwrap();
        let mut p = ExportProcess::start(&ffmpeg, j).unwrap();
        p.write_chunk(&h264).unwrap();
        p.finish().unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 100);
    }

    #[test]
    fn cancel_removes_part() {
        let (ffmpeg, _) = tools_or_skip!("cancel_removes_part");
        let dir = temp_dir("cancel");
        let h264 = fixtures(&ffmpeg, &dir);
        let j = job(&dir, None);
        let out = j.out_path.clone();
        let mut p = ExportProcess::start(&ffmpeg, j).unwrap();
        p.write_chunk(&h264[..h264.len() / 2]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        p.cancel();
        assert!(!part_of(&out).exists(), ".part must be deleted");
        assert!(!out.exists());
    }

    #[test]
    fn ffmpeg_failure_keeps_target_untouched() {
        let (ffmpeg, _) = tools_or_skip!("ffmpeg_failure");
        let dir = temp_dir("fail");
        let _ = fixtures(&ffmpeg, &dir);
        let j = job(&dir, None);
        let out = j.out_path.clone();
        std::fs::write(&out, b"precious").unwrap();
        let mut p = ExportProcess::start(&ffmpeg, j).unwrap();
        let _ = p.write_chunk(&[0x13u8; 8192]);
        let err = p.finish().expect_err("garbage input must fail");
        assert!(!err.is_empty());
        assert_eq!(std::fs::read(&out).unwrap(), b"precious");
        assert!(!part_of(&out).exists(), ".part must be deleted");
    }
}
