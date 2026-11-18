//! The running export: FFmpeg fed H.264 chunks on stdin, writing `<out>.part`, renamed on success.

use crate::ExportJob;
use crate::args::{ffmpeg_args, part_path};
use crate::tools::command;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

const STDERR_LINES: usize = 20;

/// What a finished export wrote. Sent to the page as JSON with camelCase names.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub out_path: PathBuf,
    pub duration_us: i64,
    pub size_bytes: u64,
}

/// A running FFmpeg muxer. Feed it the encoded video with `write_chunk`, then `finish` or `cancel`.
/// Dropping it unfinished behaves like `cancel`.
pub struct ExportProcess {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
    stdin: Option<ChildStdin>,
    stderr: Option<JoinHandle<VecDeque<String>>>,
    out_path: PathBuf,
    part: PathBuf,
    duration_us: i64,
    pipe_broken: bool,
    done: bool,
}

/// Lets another thread stop a running export, also while `finish` is waiting or `write_chunk` is
/// blocked. `finish` never times out by itself (a long export is legitimate); the owner of the job
/// decides when to give up and calls `cancel` on a clone of this handle. After it, `finish` returns
/// `Err("export cancelled")` and `.part` is deleted. Cancelling an export that already ended is harmless.
#[derive(Clone)]
pub struct CancelHandle {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

impl CancelHandle {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = lock(&self.child).kill();
    }
}

fn lock(child: &Mutex<Child>) -> MutexGuard<'_, Child> {
    child.lock().unwrap_or_else(|e| e.into_inner())
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
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            cancelled: Arc::new(AtomicBool::new(false)),
            stdin,
            stderr,
            out_path: job.out_path,
            part,
            duration_us: job.output_duration_us,
            pipe_broken: false,
            done: false,
        })
    }

    /// A handle another thread can use to kill this export (see `CancelHandle`).
    pub fn cancel_handle(&self) -> CancelHandle {
        CancelHandle { child: Arc::clone(&self.child), cancelled: Arc::clone(&self.cancelled) }
    }

    /// Send the next chunk of H.264 annexb. A `BrokenPipe` error means FFmpeg has already exited
    /// (it normally keeps reading until `finish` closes the stream, so this is usually a failure, but
    /// it can also be a clean early stop at the `-t` output length). Callers should stop sending and
    /// call `finish`: it decides on FFmpeg's exit status only, so it returns Ok if FFmpeg exited 0
    /// even though a late write saw the broken pipe, and FFmpeg's own error otherwise.
    pub fn write_chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(bytes).inspect_err(|e| {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    self.pipe_broken = true;
                }
            }),
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "ffmpeg stdin is closed")),
        }
    }

    /// Close the video stream, wait for FFmpeg (no timeout, see `CancelHandle`), then move `.part`
    /// to the final name, replacing an existing file (the save dialog already asked). On any failure
    /// `.part` is deleted and the existing target is left as it was.
    pub fn finish(mut self) -> Result<ExportReport, String> {
        self.done = true;
        drop(self.stdin.take());
        let status = loop {
            let polled = lock(&self.child).try_wait();
            match polled {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => {
                    self.kill_and_clean();
                    return Err(format!("could not wait for ffmpeg: {e}"));
                }
            }
        };
        let lines = self.stderr.take().and_then(|h| h.join().ok()).unwrap_or_default();
        if !status.success() {
            let _ = std::fs::remove_file(&self.part);
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("export cancelled".to_string());
            }
            let tail = lines.into_iter().collect::<Vec<_>>().join("
");
            let cut = if self.pipe_broken { " (it closed its input early)" } else { "" };
            return Err(format!("ffmpeg exited with {status}{cut}: {tail}"));
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
        self.kill_and_clean();
    }

    fn kill_and_clean(&mut self) {
        self.done = true;
        drop(self.stdin.take());
        {
            let mut child = lock(&self.child);
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(h) = self.stderr.take() {
            let _ = h.join();
        }
        let _ = std::fs::remove_file(&self.part);
    }
}

impl Drop for ExportProcess {
    fn drop(&mut self) {
        if !self.done {
            self.kill_and_clean();
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
        fixtures_with_mic(ffmpeg, dir, 3)
    }

    fn fixtures_with_mic(ffmpeg: &Path, dir: &Path, mic_secs: u32) -> Vec<u8> {
        let out = command(ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let wav = dir.join("mic.wav");
        let st = command(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", &mic_secs.to_string()])
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

    /// Packet DTS values (seconds) of the audio track, in file order.
    fn audio_dts(ffprobe: &Path, file: &Path) -> Vec<f64> {
        let out = command(ffprobe).args(["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=dts_time", "-of", "csv=p=0"]).arg(file).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    /// Run a whole export of the 2 s fixture video with a mic of `mic_secs` and the given segments.
    /// A watchdog kills FFmpeg after 20 s, so a hang fails the test (finish returns Err) instead of
    /// hanging the suite.
    fn run_with_deadline(ffmpeg: &Path, tag: &str, mic_secs: u32, segments: Vec<(i64, i64)>) -> Result<PathBuf, String> {
        let dir = temp_dir(tag);
        let h264 = fixtures_with_mic(ffmpeg, &dir, mic_secs);
        let mut j = job(&dir, mic(0));
        let mut out_start = 0;
        j.segments = segments
            .into_iter()
            .map(|(s, e)| {
                let seg = Segment { src_start_us: s, src_end_us: e, out_start_us: out_start };
                out_start += e - s;
                seg
            })
            .collect();
        assert_eq!(out_start, 2_000_000, "test segments must add up to the 2 s video");
        let out = j.out_path.clone();
        let mut p = ExportProcess::start(ffmpeg, j).unwrap();
        let handle = p.cancel_handle();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if done_rx.recv_timeout(std::time::Duration::from_secs(20)).is_err() {
                handle.cancel();
            }
        });
        for chunk in h264.chunks(4096) {
            let _ = p.write_chunk(chunk);
        }
        let result = p.finish();
        let _ = done_tx.send(());
        watchdog.join().unwrap();
        result.map(|_| out)
    }

    fn check_output(ffmpeg: &Path, ffprobe: &Path, out: &Path) {
        let (kinds, dur) = probe(ffprobe, out);
        assert!(kinds.contains(&"video".to_string()) && kinds.contains(&"audio".to_string()), "{kinds:?}");
        assert!((dur - 2.0).abs() <= 1.0 / 30.0, "duration {dur}");
        let dts = audio_dts(ffprobe, out);
        assert!(!dts.is_empty());
        assert!(dts.windows(2).all(|w| w[1] > w[0]), "audio DTS must increase: {dts:?}");
        let _ = ffmpeg;
    }

    #[test]
    fn segment_wholly_past_a_short_mic_is_silence_and_does_not_hang() {
        let (ffmpeg, ffprobe) = tools_or_skip!("segment_past_short_mic");
        // 1 s mic: the second segment (1.2 s to 2.2 s) starts after the mic ended.
        let out = run_with_deadline(&ffmpeg, "past", 1, vec![(0, 1_000_000), (1_200_000, 2_200_000)]).expect("export must finish");
        check_output(&ffmpeg, &ffprobe, &out);
        assert!(max_volume_db(&ffmpeg, &out) > -20.0, "the first second is the mic");
    }

    #[test]
    fn segment_straddling_the_mic_end_is_padded() {
        let (ffmpeg, ffprobe) = tools_or_skip!("segment_straddles_mic_end");
        // 1 s mic: the first segment (0.5 s to 1.5 s) has 0.5 s of mic then silence; the second is past the end.
        let out = run_with_deadline(&ffmpeg, "straddle", 1, vec![(500_000, 1_500_000), (1_600_000, 2_600_000)]).expect("export must finish");
        check_output(&ffmpeg, &ffprobe, &out);
    }

    #[test]
    fn three_segments_with_an_empty_middle_one_stay_monotonic() {
        let (ffmpeg, ffprobe) = tools_or_skip!("three_segments_empty_middle");
        // 1 s mic: the middle segment (1.2 s to 1.8 s) is wholly past the mic, the last one straddles its end.
        let out = run_with_deadline(&ffmpeg, "three", 1, vec![(0, 800_000), (1_200_000, 1_800_000), (800_000, 1_400_000)]).expect("export must finish");
        check_output(&ffmpeg, &ffprobe, &out);
    }

    #[test]
    fn cancel_handle_stops_finish_from_another_thread() {
        let (ffmpeg, _) = tools_or_skip!("cancel_handle");
        let dir = temp_dir("handle");
        let _ = fixtures(&ffmpeg, &dir);
        let j = job(&dir, None);
        let out = j.out_path.clone();
        let mut p = ExportProcess::start(&ffmpeg, j).unwrap();
        p.write_chunk(&[0u8; 16]).unwrap();
        let handle = p.cancel_handle();
        let killer = std::thread::spawn(move || handle.cancel());
        killer.join().unwrap();
        let started = std::time::Instant::now();
        let err = p.finish().expect_err("cancelled");
        assert_eq!(err, "export cancelled");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(!part_of(&out).exists());
        assert!(!out.exists());
    }
}
