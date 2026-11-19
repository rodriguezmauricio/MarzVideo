//! Live transcription for the AI checklist: read the `mic.wav` the engine is still writing, cut it
//! into short overlapping chunks, gate silence, and turn Whisper's words into recording time.
//! Only reads files; the capture engine is not touched. See
//! `docs/superpowers/specs/2026-11-19-ai-checklist-design.md`.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::sections::write_wav_mono16;
use crate::transcript::Word;
use crate::whisper::{parse_whisper_json, whisper_args};

/// The engine's mic rate.
pub const MIC_RATE: u32 = 48_000;
/// A chunk is cut when this much new audio is there.
pub const CHUNK_MIN_NEW_US: i64 = 6_000_000;
/// Each chunk also takes this much audio before it (words cut at the edge).
pub const CHUNK_OVERLAP_US: i64 = 1_000_000;
/// At most this much audio per chunk.
pub const CHUNK_MAX_US: i64 = 30_000_000;
/// A chunk whose peak is below this is silence (or mute) and is not sent to Whisper.
pub const SILENCE_DBFS: f64 = -45.0;

/// Format and start of the sample data of a 16-bit PCM WAV, from its first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavLayout {
    pub data_start: u64,
    pub channels: u16,
    pub rate: u32,
}

/// Reads the RIFF chunks up to `data`. The `data` size is ignored (0 while the engine writes).
pub fn wav_layout(head: &[u8]) -> Option<WavLayout> {
    if head.len() < 12 || &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u32, u16)> = None;
    while pos + 8 <= head.len() {
        let id = &head[pos..pos + 4];
        let size = u32::from_le_bytes(head[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            let f = head.get(body..body + 16)?;
            let format = u16::from_le_bytes([f[0], f[1]]);
            let channels = u16::from_le_bytes([f[2], f[3]]);
            let rate = u32::from_le_bytes([f[4], f[5], f[6], f[7]]);
            let bits = u16::from_le_bytes([f[14], f[15]]);
            if (format != 1 && format != 0xFFFE) || bits != 16 || channels == 0 {
                return None;
            }
            fmt = Some((channels, rate, bits));
        } else if id == b"data" {
            let (channels, rate, _) = fmt?;
            return Some(WavLayout { data_start: body as u64, channels, rate });
        }
        pos = body + size + (size & 1);
    }
    None
}

/// A WAV that is still growing: each `read_new` returns the mono samples written since the last
/// call (the first channel when there are more), whole frames only.
pub struct GrowingWav {
    path: PathBuf,
    layout: Option<WavLayout>,
    /// Byte position of the next frame to read.
    pos: u64,
}

impl GrowingWav {
    pub fn new(path: &Path) -> Self {
        GrowingWav { path: path.to_path_buf(), layout: None, pos: 0 }
    }

    pub fn layout(&self) -> Option<WavLayout> {
        self.layout
    }

    /// New samples, at most `max_frames`. Empty while the file or its header is not there yet.
    pub fn read_new(&mut self, max_frames: usize) -> io::Result<Vec<i16>> {
        let mut f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        if self.layout.is_none() {
            let mut head = vec![0u8; 4096];
            let n = read_up_to(&mut f, &mut head)?;
            let Some(l) = wav_layout(&head[..n]) else { return Ok(Vec::new()) };
            self.layout = Some(l);
            self.pos = l.data_start;
        }
        let l = self.layout.expect("set above");
        let frame = u64::from(l.channels) * 2;
        let len = f.metadata()?.len();
        let frames = (len.saturating_sub(self.pos) / frame).min(max_frames as u64);
        if frames == 0 {
            return Ok(Vec::new());
        }
        f.seek(SeekFrom::Start(self.pos))?;
        let mut buf = vec![0u8; (frames * frame) as usize];
        f.read_exact(&mut buf)?;
        self.pos += frames * frame;
        Ok(buf.chunks_exact(frame as usize).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
    }
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// 48 kHz to 16 kHz: the mean of each 3 samples (speech only needs the low band).
pub fn downsample_3(pcm: &[i16]) -> Vec<i16> {
    pcm.chunks(3).map(|c| (c.iter().map(|&s| i32::from(s)).sum::<i32>() / c.len() as i32) as i16).collect()
}

/// Peak level in dBFS (-inf for silence).
pub fn peak_dbfs(pcm: &[i16]) -> f64 {
    let peak = pcm.iter().map(|&s| i32::from(s).unsigned_abs()).max().unwrap_or(0);
    if peak == 0 { f64::NEG_INFINITY } else { 20.0 * (f64::from(peak) / 32768.0).log10() }
}

/// One chunk to transcribe: its samples at `rate` and where it starts in file time.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub start_us: i64,
    pub pcm: Vec<i16>,
}

/// The audio read so far, and how far it was cut into chunks.
pub struct ChunkPlanner {
    rate: u32,
    /// File sample index of `buf[0]`.
    base: i64,
    buf: Vec<i16>,
    /// File sample index up to which chunks were cut.
    done: i64,
}

impl ChunkPlanner {
    pub fn new(rate: u32) -> Self {
        ChunkPlanner { rate, base: 0, buf: Vec::new(), done: 0 }
    }

    fn samples(&self, us: i64) -> i64 {
        us * i64::from(self.rate) / 1_000_000
    }

    pub fn push(&mut self, pcm: &[i16]) {
        self.buf.extend_from_slice(pcm);
    }

    /// File time of the end of what was read.
    pub fn end_us(&self) -> i64 {
        (self.base + self.buf.len() as i64) * 1_000_000 / i64::from(self.rate)
    }

    /// The next chunk once `CHUNK_MIN_NEW_US` of new audio is there (`flush`: any new audio):
    /// from the last cut minus the overlap, at most `CHUNK_MAX_US` of new audio.
    pub fn next(&mut self, flush: bool) -> Option<Chunk> {
        let end = self.base + self.buf.len() as i64;
        let new = end - self.done;
        if new <= 0 || (!flush && new < self.samples(CHUNK_MIN_NEW_US)) {
            return None;
        }
        let cut = (self.done + self.samples(CHUNK_MAX_US)).min(end);
        let start = (self.done - self.samples(CHUNK_OVERLAP_US)).max(self.base);
        let pcm = self.buf[(start - self.base) as usize..(cut - self.base) as usize].to_vec();
        self.done = cut;
        // Keep only what the next overlap needs.
        let keep_from = (cut - self.samples(CHUNK_OVERLAP_US)).max(self.base);
        self.buf.drain(..(keep_from - self.base) as usize);
        self.base = keep_from;
        Some(Chunk { start_us: start * 1_000_000 / i64::from(self.rate), pcm })
    }
}

/// Whisper's input rate.
const WHISPER_RATE: u32 = 16_000;
/// A chunk that takes longer than this is given up.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(40);

/// What one chunk needs from the outside.
pub struct LiveWhisper<'a> {
    pub whisper: &'a Path,
    pub model: &'a Path,
    pub vad: Option<&'a Path>,
    /// Folder for the chunk's WAV and JSON (deleted files, the folder stays).
    pub work: &'a Path,
    /// Whisper's `--prompt`: the topic texts, so it spells his terms.
    pub prompt: &'a str,
}

/// Transcribes one chunk of 16 kHz audio. Words come back in recording time: file time
/// `start_us` plus `first_rec_us` (where `mic.wav` starts on the recording clock). Whisper runs at
/// below-normal priority without a window; `stop` is polled and kills it.
pub fn transcribe_chunk(w: &LiveWhisper<'_>, pcm16k: &[i16], start_us: i64, first_rec_us: i64, stop: &dyn Fn() -> bool) -> Result<Vec<Word>, String> {
    let wav = w.work.join("chunk.wav");
    let base = w.work.join("chunk");
    let json_path = w.work.join("chunk.json");
    let _ = std::fs::remove_file(&json_path);
    write_wav_mono16(&wav, WHISPER_RATE, pcm16k).map_err(|e| format!("cannot write the chunk: {e}"))?;
    let mut cmd = Command::new(w.whisper);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    let mut child = cmd
        .args(whisper_args(w.model, w.vad, &wav, &base, None, w.prompt))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot run whisper: {e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if stop() || started.elapsed() > CHUNK_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&wav);
            return Err("whisper stopped".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = std::fs::remove_file(&wav);
    if !status.success() {
        return Err(format!("whisper failed ({status})"));
    }
    let json = std::fs::read(&json_path).map_err(|e| format!("whisper wrote nothing: {e}"))?;
    let _ = std::fs::remove_file(&json_path);
    parse_whisper_json(&String::from_utf8_lossy(&json), start_us, first_rec_us, 0).map(|(_, words)| words)
}

/// Prepares a chunk for Whisper: None for silence (peak under `SILENCE_DBFS`), else 16 kHz samples.
pub fn chunk_for_whisper(pcm: &[i16], rate: u32) -> Option<Vec<i16>> {
    if peak_dbfs(pcm) < SILENCE_DBFS {
        return None;
    }
    match rate {
        48_000 => Some(downsample_3(pcm)),
        16_000 => Some(pcm.to_vec()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn header(channels: u16, rate: u32, data_bytes: u32, extra_chunk: bool) -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&0u32.to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&channels.to_le_bytes());
        h.extend_from_slice(&rate.to_le_bytes());
        h.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        h.extend_from_slice(&(channels * 2).to_le_bytes());
        h.extend_from_slice(&16u16.to_le_bytes());
        if extra_chunk {
            h.extend_from_slice(b"LIST");
            h.extend_from_slice(&5u32.to_le_bytes());
            h.extend_from_slice(b"INFOx\0"); // 5 bytes + pad
        }
        h.extend_from_slice(b"data");
        h.extend_from_slice(&data_bytes.to_le_bytes());
        h
    }

    fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn layout_finds_data_after_other_chunks() {
        assert_eq!(wav_layout(&header(1, 48_000, 0, false)), Some(WavLayout { data_start: 44, channels: 1, rate: 48_000 }));
        assert_eq!(wav_layout(&header(2, 16_000, 0, true)), Some(WavLayout { data_start: 58, channels: 2, rate: 16_000 }));
        assert_eq!(wav_layout(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(wav_layout(b"not a wav at all"), None);
    }

    #[test]
    fn reads_a_file_that_grows_while_read() {
        let dir = std::env::temp_dir().join(format!("marz-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mic.wav");
        let mut g = GrowingWav::new(&path);
        assert!(g.read_new(1000).unwrap().is_empty(), "no file yet");

        // The writer keeps the file open with shared access, as the engine does.
        let mut w = File::create(&path).unwrap();
        w.write_all(&header(1, 48_000, 0, false)[..20]).unwrap();
        w.flush().unwrap();
        assert!(g.read_new(1000).unwrap().is_empty(), "half a header");
        w.write_all(&header(1, 48_000, 0, false)[20..]).unwrap();
        w.write_all(&pcm_bytes(&[1, 2, 3])).unwrap();
        w.write_all(&[9]).unwrap(); // half a sample
        w.flush().unwrap();
        assert_eq!(g.read_new(1000).unwrap(), vec![1, 2, 3]);
        w.write_all(&[0]).unwrap(); // the rest of sample 9
        w.write_all(&pcm_bytes(&[4, 5, 6, 7])).unwrap();
        w.flush().unwrap();
        assert_eq!(g.read_new(2).unwrap(), vec![9, 4]);
        assert_eq!(g.read_new(1000).unwrap(), vec![5, 6, 7]);
        assert!(g.read_new(1000).unwrap().is_empty());
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stereo_reads_the_first_channel() {
        let dir = std::env::temp_dir().join(format!("marz-live-st-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.wav");
        let mut bytes = header(2, 48_000, 8, true);
        bytes.extend(pcm_bytes(&[10, -10, 20, -20]));
        std::fs::write(&path, bytes).unwrap();
        let mut g = GrowingWav::new(&path);
        assert_eq!(g.read_new(100).unwrap(), vec![10, 20]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn downsample_and_peak() {
        assert_eq!(downsample_3(&[3, 6, 9, 30, 30, 30, 7]), vec![6, 30, 7]);
        assert_eq!(peak_dbfs(&[0, 0]), f64::NEG_INFINITY);
        assert!((peak_dbfs(&[16384, -100]) - (-6.02)).abs() < 0.01);
        assert!(peak_dbfs(&[150]) < SILENCE_DBFS);
        assert!(peak_dbfs(&[2000]) > SILENCE_DBFS);
    }

    #[test]
    fn silence_is_not_sent_and_48k_is_downsampled() {
        assert_eq!(chunk_for_whisper(&[10; 300], 48_000), None);
        assert_eq!(chunk_for_whisper(&[5000; 300], 48_000).unwrap().len(), 100);
        assert_eq!(chunk_for_whisper(&[5000; 300], 16_000).unwrap().len(), 300);
        assert_eq!(chunk_for_whisper(&[5000; 300], 44_100), None, "only the engine's rate or Whisper's");
    }

    #[test]
    fn planner_cuts_overlapping_chunks() {
        // 1 kHz keeps the numbers small: 1 sample = 1 ms.
        let mut p = ChunkPlanner::new(1000);
        p.push(&vec![1; 5_999]);
        assert_eq!(p.next(false), None, "under 6 s");
        p.push(&[1]);
        let c = p.next(false).unwrap();
        assert_eq!((c.start_us, c.pcm.len()), (0, 6_000));
        p.push(&vec![2; 6_500]);
        let c = p.next(false).unwrap();
        assert_eq!(c.start_us, 5_000_000, "1 s overlap before the new audio");
        assert_eq!(c.pcm.len(), 7_500);
        assert_eq!(p.end_us(), 12_500_000);
        p.push(&vec![3; 500]);
        assert_eq!(p.next(false), None);
        let c = p.next(true).unwrap();
        assert_eq!((c.start_us, c.pcm.len()), (11_500_000, 1_500));
        assert_eq!(p.next(true), None, "nothing new");
    }

    #[test]
    fn planner_caps_a_chunk_at_30_s_and_catches_up() {
        let mut p = ChunkPlanner::new(1000);
        p.push(&vec![0; 70_000]);
        let a = p.next(false).unwrap();
        assert_eq!((a.start_us, a.pcm.len()), (0, 30_000));
        let b = p.next(false).unwrap();
        assert_eq!((b.start_us, b.pcm.len()), (29_000_000, 31_000));
        let c = p.next(false).unwrap();
        assert_eq!((c.start_us, c.pcm.len()), (59_000_000, 11_000));
        assert_eq!(p.next(false), None);
    }
}
