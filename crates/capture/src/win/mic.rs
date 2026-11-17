//! Microphone capture with WASAPI (the spike's proven setup): shared event mode, autoconvert to
//! 48 kHz mono s16, packet `u64QPCPosition` as the mic clock. Every packet goes through
//! `MicTimeline`, which drops warm-up and paused audio and pads gaps with silence.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::qpc::qpc_hns;
use super::{rec_hns, SharedClock, Warnings};
use crate::mic_timeline::{MicAction, MicTimeline};
use crate::CaptureError;

pub const RATE: u32 = 48_000;
const CHANNELS: u16 = 1;
const BITS: u16 = 16;
const BYTES_PER_FRAME: u64 = 2;
const WAV_HEADER_BYTES: u64 = 44;
/// How often the meter level is published.
const LEVEL_EVERY_HNS: i64 = 500_000; // 50 ms
/// Event wait, so a stop is seen quickly even if the device goes quiet.
const WAIT_MS: u32 = 100;

pub const MIC_LOST: &str = "Microphone disconnected. Recording continues without sound.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicDevice {
    /// WASAPI endpoint id; pass to `start`.
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// Active capture devices. Runs on its own thread so the caller's COM mode (STA in a UI) does not
/// matter. Empty on any error.
pub fn list_mics() -> Vec<MicDevice> {
    thread::spawn(|| -> Result<Vec<MicDevice>, wasapi::WasapiError> {
        let _ = initialize_mta();
        let en = DeviceEnumerator::new()?;
        let default_id = en.get_default_device(Direction::Capture).and_then(|d| d.get_id()).ok();
        let mut out = Vec::new();
        for dev in &en.get_device_collection(Direction::Capture)? {
            let Ok(dev) = dev else { continue };
            let Ok(id) = dev.get_id() else { continue };
            let name = dev.get_friendlyname().unwrap_or_else(|_| "Microphone".to_string());
            out.push(MicDevice { default: default_id.as_deref() == Some(id.as_str()), id, name });
        }
        Ok(out)
    })
    .join()
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default()
}

/// Shared between the session and the mic thread. See the `win` module docs.
pub struct MicShared {
    pub clock: SharedClock,
    /// Set on the first packet, before t0 too.
    pub warm: AtomicBool,
    /// When set, zeros are written in place of the audio (the timeline keeps running).
    pub muted: AtomicBool,
    /// Peak level 0..1 of the last 50 ms, as `f32` bits. 0 while muted.
    level: AtomicU32,
    /// Set when the device was lost; the thread has ended.
    pub lost: AtomicBool,
    pub warn: Warnings,
}

impl MicShared {
    pub fn new(clock: SharedClock, warn: Warnings) -> Arc<Self> {
        Arc::new(Self {
            clock,
            warm: AtomicBool::new(false),
            muted: AtomicBool::new(false),
            level: AtomicU32::new(0f32.to_bits()),
            lost: AtomicBool::new(false),
            warn,
        })
    }

    pub fn is_warm(&self) -> bool {
        self.warm.load(Ordering::SeqCst)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
    }

    /// Peak level 0..1 for the meter, refreshed every 50 ms.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

/// What the thread hands back to `MicHandle::stop`.
struct MicOutput {
    wav: BufWriter<File>,
    timeline: MicTimeline,
}

pub struct MicHandle {
    pub device_name: String,
    shared: Arc<MicShared>,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<MicOutput, CaptureError>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicReport {
    pub device_name: String,
    /// Recording time of the first sample: `tracks.mic.offsetUs`. None if no audio arrived after t0
    /// (the file is then all silence from 0).
    pub first_rec_us: Option<i64>,
    /// Silence inserted for gaps while recording.
    pub gap_padded_us: i64,
    /// Silence appended at stop to reach the duration (large after a device loss).
    pub end_padded_us: i64,
    /// Samples in the final file.
    pub frames: u64,
    pub lost: bool,
}

/// Write the 44-byte PCM WAV header for 48 kHz mono s16.
fn write_wav_header(f: &mut impl Write, data_bytes: u32) -> io::Result<()> {
    let block = CHANNELS * BITS / 8;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_bytes).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&CHANNELS.to_le_bytes())?;
    f.write_all(&RATE.to_le_bytes())?;
    f.write_all(&(RATE * u32::from(block)).to_le_bytes())?;
    f.write_all(&block.to_le_bytes())?;
    f.write_all(&BITS.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_bytes.to_le_bytes())?;
    Ok(())
}

fn write_silence(w: &mut impl Write, frames: u64) -> io::Result<()> {
    const ZEROS: [u8; 4096] = [0; 4096];
    let mut left = frames * BYTES_PER_FRAME;
    while left > 0 {
        let n = left.min(ZEROS.len() as u64) as usize;
        w.write_all(&ZEROS[..n])?;
        left -= n as u64;
    }
    Ok(())
}

/// Start capturing `device_id` (None = the default mic) into a new WAV at `wav_path`. Returns once
/// the stream runs, or the device error.
pub fn start(device_id: Option<&str>, wav_path: &Path, shared: Arc<MicShared>) -> Result<MicHandle, CaptureError> {
    let mut file = File::create(wav_path)?;
    write_wav_header(&mut file, 0)?;
    let wav = BufWriter::new(file);
    let id = device_id.map(str::to_string);
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<String, CaptureError>>();
    let thread = {
        let (stop, shared) = (stop.clone(), shared.clone());
        thread::Builder::new()
            .name("marz-mic".into())
            .spawn(move || mic_thread(id, wav, shared, stop, ready_tx))?
    };
    match ready_rx.recv() {
        Ok(Ok(device_name)) => Ok(MicHandle { device_name, shared, stop, thread }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err(CaptureError::Device("the microphone thread ended during setup".into()))
        }
    }
}

enum LoopError {
    Device,
    Io(io::Error),
}

fn mic_thread(
    id: Option<String>,
    mut wav: BufWriter<File>,
    shared: Arc<MicShared>,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<String, CaptureError>>,
) -> Result<MicOutput, CaptureError> {
    let dev_err = |what: &str, e: wasapi::WasapiError| CaptureError::Device(format!("microphone {what}: {e}"));
    let setup = || -> Result<_, CaptureError> {
        let _ = initialize_mta();
        let en = DeviceEnumerator::new().map_err(|e| dev_err("enumeration failed", e))?;
        let dev = match &id {
            Some(id) => en.get_device(id),
            None => en.get_default_device(Direction::Capture),
        }
        .map_err(|e| dev_err("not found", e))?;
        let name = dev.get_friendlyname().unwrap_or_default();
        let mut client = dev.get_iaudioclient().map_err(|e| dev_err("could not open", e))?;
        let fmt = WaveFormat::new(BITS as usize, BITS as usize, SampleType::Int, RATE as usize, CHANNELS as usize, None);
        let (_def, min) = client.get_device_period().map_err(|e| dev_err("period", e))?;
        client
            .initialize_client(&fmt, Direction::Capture, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min }, None)
            .map_err(|e| dev_err("could not start", e))?;
        let ev = client.set_get_eventhandle().map_err(|e| dev_err("event", e))?;
        let cap = client.get_audiocaptureclient().map_err(|e| dev_err("capture client", e))?;
        client.start_stream().map_err(|e| dev_err("could not start", e))?;
        Ok((name, client, ev, cap))
    };
    let (name, client, ev, cap) = match setup() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(CaptureError::Device(e.to_string())));
            return Err(e);
        }
    };
    let _ = ready.send(Ok(name));

    let mut timeline = MicTimeline::new(RATE);
    let mut q: VecDeque<u8> = VecDeque::with_capacity(RATE as usize * 2);
    let mut peak = 0f32;
    let mut last_level = qpc_hns();
    let mut result = Ok(());
    while !stop.load(Ordering::SeqCst) {
        let _ = ev.wait_for_event(WAIT_MS); // a timeout still polls, so a lost device is noticed
        let drained = (|| -> Result<(), LoopError> {
            loop {
                match cap.get_next_packet_size().map_err(|_| LoopError::Device)? {
                    Some(0) | None => return Ok(()),
                    Some(_) => {}
                }
                q.clear();
                let info = cap.read_from_device_to_deque(&mut q).map_err(|_| LoopError::Device)?;
                let frames = q.len() / BYTES_PER_FRAME as usize;
                if frames == 0 {
                    return Ok(());
                }
                shared.warm.store(true, Ordering::SeqCst);
                let pcm = q.make_contiguous();
                let muted = shared.muted.load(Ordering::Relaxed);
                if !muted {
                    for s in pcm.as_chunks::<2>().0 {
                        let v = f32::from(i16::from_le_bytes(*s)).abs() / 32768.0;
                        peak = peak.max(v);
                    }
                }
                let rec = rec_hns(&shared.clock, info.timestamp as i64);
                if let MicAction::Write { silence_before } = timeline.packet(rec, frames) {
                    write_silence(&mut wav, silence_before).map_err(LoopError::Io)?;
                    if muted {
                        write_silence(&mut wav, frames as u64).map_err(LoopError::Io)?;
                    } else {
                        wav.write_all(pcm).map_err(LoopError::Io)?;
                    }
                }
            }
        })();
        let now = qpc_hns();
        if now - last_level >= LEVEL_EVERY_HNS {
            let level = if shared.muted.load(Ordering::Relaxed) { 0.0 } else { peak.min(1.0) };
            shared.level.store(level.to_bits(), Ordering::Relaxed);
            peak = 0.0;
            last_level = now;
        }
        match drained {
            Ok(()) => {}
            Err(LoopError::Device) => {
                if !stop.load(Ordering::SeqCst) {
                    shared.lost.store(true, Ordering::SeqCst);
                    shared.level.store(0f32.to_bits(), Ordering::Relaxed);
                    let _ = shared.warn.send(MIC_LOST.to_string());
                }
                break;
            }
            Err(LoopError::Io(e)) => {
                result = Err(CaptureError::Io(e));
                break;
            }
        }
    }
    let _ = client.stop_stream();
    result.map(|()| MicOutput { wav, timeline })
}

impl MicHandle {
    /// Stop the stream, then pad the file with silence (or cut it) so it ends at `duration_us`
    /// on the recording clock, and patch the WAV header.
    pub fn stop(self, duration_us: i64) -> Result<MicReport, CaptureError> {
        self.stop.store(true, Ordering::SeqCst);
        let MicOutput { mut wav, mut timeline } = self
            .thread
            .join()
            .map_err(|_| CaptureError::Device("the microphone thread panicked".into()))??;
        let first = timeline.first_rec_us();
        // The file starts at the first sample, so its target length is measured from there.
        let file_us = duration_us - first.unwrap_or(0);
        let add = timeline.finish(file_us);
        write_silence(&mut wav, add)?;
        let excess = timeline.excess_frames(file_us);
        let mut file = wav.into_inner().map_err(|e| CaptureError::Io(e.into_error()))?;
        let data_bytes = file.metadata()?.len().saturating_sub(WAV_HEADER_BYTES).saturating_sub(excess * BYTES_PER_FRAME);
        let data_bytes = data_bytes.min(u64::from(u32::MAX - 36)) & !1;
        file.set_len(WAV_HEADER_BYTES + data_bytes)?;
        file.seek(SeekFrom::Start(0))?;
        write_wav_header(&mut file, data_bytes as u32)?;
        file.sync_all()?;
        Ok(MicReport {
            device_name: self.device_name,
            first_rec_us: first,
            gap_padded_us: timeline.padded_us(),
            end_padded_us: (u128::from(add) * 1_000_000 / u128::from(RATE)) as i64,
            frames: data_bytes / BYTES_PER_FRAME,
            lost: self.shared.lost.load(Ordering::SeqCst),
        })
    }
}
