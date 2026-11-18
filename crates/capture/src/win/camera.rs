//! Webcam capture with the Media Foundation Source Reader (the camera spike's settings,
//! `docs/spikes/2026-11-19-camera-spike.md`).
//!
//! Flow: `ReadSample` on the camera's own thread, then the device timestamp (QPC, 100 ns, the clock
//! WGC and WASAPI use) minus the camera delay, then `RecClock::rec_hns`, then `Slotter::slot_for`
//! at 30 fps, then the NV12 picture is copied into a pooled buffer and sent to the writer, as the
//! screen does. The writer repeats the last frame over gaps, so a camera that slows down in a dim
//! room (17 to 19 fps measured) still gives a constant 30 fps file in sync.
//!
//! A camera held by another app opens but fails its first `ReadSample` with `0xC00D3704`: the
//! thread sets `failed` with `CAMERA_BUSY` and ends. A camera that stops mid-take sets `lost`, warns
//! once and ends; the writer pads `camera.mp4` with its last frame to the end.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{GUID, Interface, PWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

use super::{rec_hns, SharedClock, Warnings};
use crate::slots::Slotter;
use crate::writer::{CaptureEnds, SlotFrame};
use crate::CaptureError;

/// The camera track's frame rate. Never above 30: plenty for a face, half the encoder load.
pub const CAMERA_FPS: u32 = 30;

/// The camera's own delay (sensor exposure and USB) subtracted from its device timestamps. The
/// device timestamp is set when the driver delivers the frame, so it does not include it. Zero until
/// the owner clap check measures it (spike, "Not measured here").
pub const CAMERA_DELAY_HNS: i64 = 0;

pub const CAMERA_BUSY: &str = "This camera is used by another app. Close it or pick another camera.";
pub const CAMERA_DID_NOT_START: &str = "The camera did not start. Recording without it.";
pub const CAMERA_STOPPED: &str = "The camera stopped. The camera video holds its last picture.";
pub const CAMERA_NOT_FOUND: &str = "This camera was not found. Pick another one.";

/// `MF_E_HW_MFT_FAILED_START_STREAMING`: the camera is held by another app (spike finding 7).
const HR_CAMERA_BUSY: i32 = 0xC00D3704_u32 as i32;
const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
/// How long `stop` waits for the camera thread (a `ReadSample` returns at least every frame).
const STOP_WAIT: Duration = Duration::from_secs(2);

/// A camera Media Foundation can open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraDevice {
    /// The symbolic link: stable while the camera stays plugged in the same port.
    pub id: String,
    pub name: String,
}

/// One native mode of a camera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraMode {
    pub index: u32,
    pub nv12: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// The mode to record: the largest at or below 1920 x 1080 that reaches 30 fps, NV12 first at the
/// same size (no decode then). None when no mode reaches 30 fps; then the largest at or below
/// 1080p is used anyway (the writer fills the missing frames).
pub fn pick_mode(modes: &[CameraMode]) -> Option<CameraMode> {
    let fits = |m: &&CameraMode| m.width <= 1920 && m.height <= 1080 && m.width >= 2 && m.height >= 2;
    let best = |it: Vec<&CameraMode>| it.into_iter().max_by_key(|m| (m.width * m.height, m.nv12 as u8, (m.fps * 100.0) as u32)).copied();
    best(modes.iter().filter(fits).filter(|m| m.fps >= 29.9).collect()).or_else(|| best(modes.iter().filter(fits).collect()))
}

/// Pack an NV12 picture with row pitch `pitch` into `out` (no padding): `h` luma rows, then `h / 2`
/// chroma rows starting at `pitch * h`. Err when `src` is too small.
pub fn pack_nv12(src: &[u8], pitch: usize, w: usize, h: usize, out: &mut Vec<u8>) -> Result<(), ()> {
    out.clear();
    out.reserve(w * h * 3 / 2);
    for y in 0..h + h / 2 {
        let start = y * pitch;
        out.extend_from_slice(src.get(start..start + w).ok_or(())?);
    }
    Ok(())
}

fn mf_startup() -> Result<(), CaptureError> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| CaptureError::Device(format!("Media Foundation did not start: {e}")))
    }
}

fn mf_shutdown() {
    unsafe {
        let _ = MFShutdown();
        CoUninitialize();
    }
}

fn get_string(act: &IMFActivate, key: &GUID) -> Option<String> {
    unsafe {
        let mut p = PWSTR::null();
        let mut len = 0u32;
        act.GetAllocatedString(key, &mut p, &mut len).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s
    }
}

fn activates() -> windows::core::Result<Vec<IMFActivate>> {
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.ok_or_else(windows::core::Error::empty)?;
        attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut n = 0u32;
        MFEnumDeviceSources(&attrs, &mut list, &mut n)?;
        let mut out = Vec::new();
        for i in 0..n as usize {
            if let Some(act) = (*list.add(i)).take() {
                out.push(act);
            }
        }
        CoTaskMemFree(Some(list as _));
        Ok(out)
    }
}

fn devices_now() -> Vec<(CameraDevice, IMFActivate)> {
    activates()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|act| {
            let id = get_string(&act, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK)?;
            let name = get_string(&act, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME).unwrap_or_else(|| "Camera".into());
            Some((CameraDevice { id, name }, act))
        })
        .collect()
}

/// The cameras Media Foundation lists (DirectShow-only virtual cameras are not among them).
/// Runs on a thread of its own so the caller's COM mode does not matter.
pub fn list_cameras() -> Vec<CameraDevice> {
    thread::spawn(|| {
        if mf_startup().is_err() {
            return Vec::new();
        }
        let out = devices_now().into_iter().map(|(d, _)| d).collect();
        mf_shutdown();
        out
    })
    .join()
    .unwrap_or_default()
}

fn read_modes(reader: &IMFSourceReader) -> Vec<CameraMode> {
    let mut out = Vec::new();
    for i in 0.. {
        let Ok(t) = (unsafe { reader.GetNativeMediaType(STREAM, i) }) else { break };
        unsafe {
            let sub = t.GetGUID(&MF_MT_SUBTYPE).unwrap_or_default();
            let size = t.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
            let rate = t.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0);
            let (num, den) = ((rate >> 32) as f64, (rate & 0xffff_ffff) as f64);
            out.push(CameraMode {
                index: i,
                nv12: sub == MFVideoFormat_NV12,
                width: (size >> 32) as u32,
                height: (size & 0xffff_ffff) as u32,
                fps: if den > 0.0 { num / den } else { 0.0 },
            });
        }
    }
    out
}

/// An opened camera: the source (shut down on drop) and its reader set to NV12 in `mode`.
struct Opened {
    source: IMFMediaSource,
    reader: IMFSourceReader,
    mode: CameraMode,
}

impl Drop for Opened {
    fn drop(&mut self) {
        unsafe {
            let _ = self.source.Shutdown();
        }
    }
}

fn open(id: &str) -> Result<Opened, CaptureError> {
    let (_, act) = devices_now().into_iter().find(|(d, _)| d.id == id).ok_or_else(|| CaptureError::User(CAMERA_NOT_FOUND.into()))?;
    let dev = |e: windows::core::Error| CaptureError::Device(format!("camera: {e}"));
    unsafe {
        let source: IMFMediaSource = act.ActivateObject().map_err(dev)?;
        // Exposure priority stays as the camera has it: turning it off kept 30 fps in a dim room
        // but gave a black picture, and the camera keeps the setting for every app (2026-11-18).
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1).map_err(dev)?;
        let attrs = attrs.ok_or_else(|| CaptureError::Device("camera: no attributes".into()))?;
        // Windows decodes MJPEG and YUY2 to NV12 for us.
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1).map_err(dev)?;
        let reader = MFCreateSourceReaderFromMediaSource(&source, &attrs).map_err(dev)?;
        // Wrapped now, so the source is shut down on any error below.
        let mut o = Opened { source, reader, mode: CameraMode { index: 0, nv12: true, width: 0, height: 0, fps: 0.0 } };
        let mode = pick_mode(&read_modes(&o.reader)).ok_or_else(|| CaptureError::Device("camera: no usable mode".into()))?;
        let native = o.reader.GetNativeMediaType(STREAM, mode.index).map_err(dev)?;
        o.reader.SetCurrentMediaType(STREAM, None, &native).map_err(dev)?;
        let out = MFCreateMediaType().map_err(dev)?;
        out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(dev)?;
        out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(dev)?;
        out.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(mode.width) << 32) | u64::from(mode.height)).map_err(dev)?;
        o.reader.SetCurrentMediaType(STREAM, None, &out).map_err(dev)?;
        o.mode = CameraMode { width: mode.width & !1, height: mode.height & !1, ..mode };
        Ok(o)
    }
}

/// The native modes of camera `id` (for `marz-capture --list-cameras`). Opens the camera briefly.
pub fn camera_modes(id: &str) -> Result<(Vec<CameraMode>, Option<CameraMode>), CaptureError> {
    let id = id.to_string();
    thread::spawn(move || {
        mf_startup()?;
        let res = open(&id).map(|o| (read_modes(&o.reader), Some(o.mode)));
        mf_shutdown();
        res
    })
    .join()
    .map_err(|_| CaptureError::Device("camera thread panicked".into()))?
}

#[derive(Debug, Default)]
pub struct CameraStats {
    /// Every frame the camera delivered, warm-up included.
    pub frames_seen: AtomicU64,
    /// Frames handed to the writer.
    pub frames_sent: AtomicU64,
    /// Frames dropped because the writer queue was full.
    pub dropped_full: AtomicU64,
    /// Device timestamps of the first and last frame after t0 (hns), for the real frame rate.
    pub first_dev_hns: AtomicI64,
    pub last_dev_hns: AtomicI64,
    pub frames_after_t0: AtomicU64,
}

/// Shared between the session and the camera thread. See the `win` module docs.
pub struct CameraShared {
    pub clock: SharedClock,
    /// Set on the first frame, before t0 too.
    pub warm: AtomicBool,
    /// Set when the camera could not deliver at all; `error` says why. The thread has ended.
    pub failed: AtomicBool,
    pub error: Mutex<Option<String>>,
    /// Set when the camera stopped after it delivered; the thread has ended.
    pub lost: AtomicBool,
    first_rec_hns: AtomicI64,
    pub stats: CameraStats,
    pub warn: Warnings,
}

impl CameraShared {
    pub fn new(clock: SharedClock, warn: Warnings) -> Arc<Self> {
        Arc::new(Self {
            clock,
            warm: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            error: Mutex::new(None),
            lost: AtomicBool::new(false),
            first_rec_hns: AtomicI64::new(i64::MIN),
            stats: CameraStats::default(),
            warn,
        })
    }

    pub fn is_warm(&self) -> bool {
        self.warm.load(Ordering::SeqCst)
    }

    pub fn has_failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }

    /// The sentence to show when the camera did not start.
    pub fn error(&self) -> String {
        self.error.lock().ok().and_then(|e| e.clone()).unwrap_or_else(|| CAMERA_DID_NOT_START.to_string())
    }

    /// Recording time of the camera video's first frame (slot 0) in microseconds:
    /// `tracks.camera.offsetUs`. None until a frame was sent.
    pub fn first_rec_us(&self) -> Option<i64> {
        match self.first_rec_hns.load(Ordering::SeqCst) {
            i64::MIN => None,
            hns => Some(hns / 10),
        }
    }

    /// The camera's real frame rate after t0 (it drops in dim light).
    pub fn real_fps(&self) -> f64 {
        let n = self.stats.frames_after_t0.load(Ordering::Relaxed);
        let span = self.stats.last_dev_hns.load(Ordering::Relaxed) - self.stats.first_dev_hns.load(Ordering::Relaxed);
        if n < 2 || span <= 0 { 0.0 } else { (n - 1) as f64 * 1e7 / span as f64 }
    }

    fn fail(&self, msg: &str) {
        if let Ok(mut e) = self.error.lock() {
            *e = Some(msg.to_string());
        }
        self.failed.store(true, Ordering::SeqCst);
    }
}

/// A running camera capture.
pub struct CameraHandle {
    stop: Arc<AtomicBool>,
    /// The frame sender, dropped by `stop` so the writer ends even if the thread is stuck.
    frames: Arc<Mutex<Option<SyncSender<SlotFrame>>>>,
    done: Receiver<()>,
    thread: Option<JoinHandle<()>>,
    pub width: u32,
    pub height: u32,
}

/// Open camera `id` and start reading on its own thread. Returns once the camera is open and its
/// mode is set (`width`, `height` are the NV12 picture size for FFmpeg). Frames are thrown away
/// until the clock is set; `shared.warm` turns on with the first frame.
pub fn start(id: &str, ends: CaptureEnds, shared: Arc<CameraShared>) -> Result<CameraHandle, CaptureError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u32), CaptureError>>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let stop = Arc::new(AtomicBool::new(false));
    let CaptureEnds { frames, pool } = ends;
    let frames = Arc::new(Mutex::new(Some(frames)));
    let id = id.to_string();
    let thread = {
        let (stop, frames) = (stop.clone(), frames.clone());
        thread::Builder::new()
            .name("marz-camera".into())
            .spawn(move || {
                if let Err(e) = mf_startup() {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
                match open(&id) {
                    Ok(o) => {
                        let _ = ready_tx.send(Ok((o.mode.width, o.mode.height)));
                        read_loop(&o, &stop, &frames, &pool, &shared);
                        drop(o);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
                mf_shutdown();
                let _ = done_tx.send(());
            })
            .map_err(CaptureError::Io)?
    };
    match ready_rx.recv() {
        Ok(Ok((width, height))) => Ok(CameraHandle { stop, frames, done: done_rx, thread: Some(thread), width, height }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err(CaptureError::Device("the camera thread ended".into())),
    }
}

fn read_loop(o: &Opened, stop: &AtomicBool, frames: &Mutex<Option<SyncSender<SlotFrame>>>, pool: &Receiver<Vec<u8>>, sh: &CameraShared) {
    let (w, h) = (o.mode.width as usize, o.mode.height as usize);
    let mut slotter = Slotter::new(CAMERA_FPS);
    let mut spare: Option<Vec<u8>> = None;
    while !stop.load(Ordering::SeqCst) {
        let mut flags = 0u32;
        let mut ts = 0i64;
        let mut sample: Option<IMFSample> = None;
        let res = unsafe { o.reader.ReadSample(STREAM, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample)) };
        let ended = flags & (MF_SOURCE_READERF_ERROR.0 as u32 | MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0;
        if res.is_err() || ended {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if !sh.is_warm() {
                let busy = res.as_ref().err().is_some_and(|e| e.code().0 == HR_CAMERA_BUSY);
                sh.fail(if busy { CAMERA_BUSY } else { CAMERA_DID_NOT_START });
            } else {
                sh.lost.store(true, Ordering::SeqCst);
                let _ = sh.warn.send(CAMERA_STOPPED.to_string());
            }
            break;
        }
        let Some(s) = sample else { continue };
        sh.stats.frames_seen.fetch_add(1, Ordering::Relaxed);
        sh.warm.store(true, Ordering::SeqCst);
        // The device timestamp is the QPC time the driver delivered the frame (spike finding 3).
        let dev = unsafe { s.GetUINT64(&MFSampleExtension_DeviceTimestamp) }.map(|v| v as i64).unwrap_or(ts);
        let Some(rec) = rec_hns(&sh.clock, dev - CAMERA_DELAY_HNS) else { continue }; // warm-up, or paused
        if sh.stats.frames_after_t0.fetch_add(1, Ordering::Relaxed) == 0 {
            sh.stats.first_dev_hns.store(dev, Ordering::Relaxed);
        }
        sh.stats.last_dev_hns.store(dev, Ordering::Relaxed);
        let Some(idx) = slotter.slot_for(rec) else { continue };
        let mut buf = spare.take().or_else(|| pool.try_recv().ok()).unwrap_or_default();
        if copy_sample(&s, w, h, &mut buf).is_err() {
            spare = Some(buf);
            continue;
        }
        let Ok(guard) = frames.lock() else { break };
        let Some(tx) = guard.as_ref() else { break };
        match tx.try_send((idx, buf)) {
            Ok(()) => {
                slotter.commit(idx);
                sh.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
                if sh.first_rec_hns.load(Ordering::Relaxed) == i64::MIN
                    && let Some(slot0) = slotter.first_rec_hns()
                {
                    sh.first_rec_hns.store(slot0, Ordering::SeqCst);
                }
            }
            Err(TrySendError::Full((_, b))) => {
                sh.stats.dropped_full.fetch_add(1, Ordering::Relaxed);
                spare = Some(b);
            }
            Err(TrySendError::Disconnected((_, b))) => spare = Some(b),
        }
    }
}

/// Copy the sample's NV12 picture into `out`, tightly packed.
fn copy_sample(s: &IMFSample, w: usize, h: usize, out: &mut Vec<u8>) -> Result<(), ()> {
    unsafe {
        let buf = s.GetBufferByIndex(0).map_err(|_| ())?;
        if let Ok(b2) = buf.cast::<IMF2DBuffer>() {
            let mut p = std::ptr::null_mut();
            let mut pitch = 0i32;
            if b2.Lock2D(&mut p, &mut pitch).is_ok() {
                let res = if pitch >= w as i32 {
                    let len = pitch as usize * (h + h / 2);
                    pack_nv12(std::slice::from_raw_parts(p, len), pitch as usize, w, h, out)
                } else {
                    Err(())
                };
                let _ = b2.Unlock2D();
                if res.is_ok() {
                    return res;
                }
            }
        }
        let mut p = std::ptr::null_mut();
        let mut len = 0u32;
        buf.Lock(&mut p, None, Some(&mut len)).map_err(|_| ())?;
        let res = pack_nv12(std::slice::from_raw_parts(p, len as usize), w, w, h, out);
        let _ = buf.Unlock();
        res
    }
}

impl CameraHandle {
    /// Stop reading and close the camera. Drops the frame sender, which ends the camera writer.
    /// Waits at most two seconds for the thread; a stuck driver is left behind, never the take.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut f) = self.frames.lock() {
            f.take();
        }
        if self.done.recv_timeout(STOP_WAIT).is_ok()
            && let Some(t) = self.thread.take()
        {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(index: u32, nv12: bool, width: u32, height: u32, fps: f64) -> CameraMode {
        CameraMode { index, nv12, width, height, fps }
    }

    #[test]
    fn picks_720p30_nv12_over_mjpeg_and_low_rate_raw() {
        // The Integrated Webcam's list (spike finding 1).
        let modes = [m(0, false, 1280, 720, 30.0), m(1, true, 1280, 720, 30.0), m(2, false, 640, 480, 30.0), m(3, true, 1920, 1080, 10.0), m(4, true, 640, 360, 30.0)];
        assert_eq!(pick_mode(&modes).map(|m| m.index), Some(1));
    }

    #[test]
    fn never_above_1080p_and_falls_back_below_30_fps() {
        let modes = [m(0, true, 3840, 2160, 30.0), m(1, true, 1280, 720, 15.0), m(2, true, 640, 480, 15.0)];
        assert_eq!(pick_mode(&modes).map(|m| m.index), Some(1));
        assert_eq!(pick_mode(&[]), None);
    }

    #[test]
    fn pack_nv12_drops_row_padding() {
        // 4 x 2 picture, pitch 6: 2 luma rows and 1 chroma row.
        let src: Vec<u8> = (0..18).collect();
        let mut out = Vec::new();
        pack_nv12(&src, 6, 4, 2, &mut out).unwrap();
        assert_eq!(out, vec![0, 1, 2, 3, 6, 7, 8, 9, 12, 13, 14, 15]);
        assert!(pack_nv12(&src[..14], 6, 4, 2, &mut out).is_err());
    }
}
