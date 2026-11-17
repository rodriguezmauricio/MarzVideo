//! Screen capture with Windows Graphics Capture (the spike's proven settings). The writer thread
//! and the channels live in the cross-platform `crate::writer`.
//!
//! Flow: WGC frame, then `RecClock::rec_hns`, then `Slotter::slot_for`, then the region is copied
//! out of the mapped frame into a pooled buffer, then `try_send` to the writer, and `commit` only
//! when the send worked (a frame dropped on a full channel is retried in its slot).

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::TrySendError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};

use super::monitors::{list_monitors, monitor_at};
use super::qpc::qpc_hns;
use super::{rec_hns, set_dpi_awareness, SharedClock, Warnings};
use crate::region::{even_size, normalize_region, PxRect};
use crate::slots::Slotter;
use crate::writer::CaptureEnds;
use crate::CaptureError;

const BYTES_PER_PIXEL: usize = 4; // BGRA8

/// The area to capture, resolved before anything starts (FFmpeg needs the size first).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureRect {
    pub monitor: usize,
    /// Monitor-relative, even width and height. The full monitor when no region was given.
    pub crop: PxRect,
    /// Top-left of `crop` in virtual-screen pixels: the `EventLog` origin.
    pub origin: (i32, i32),
}

impl CaptureRect {
    /// Output frame size handed to FFmpeg and written to `source`.
    pub fn size(&self) -> (u32, u32) {
        (self.crop.w, self.crop.h)
    }
}

/// Resolve `monitor` (0-based, as in `list_monitors`) and an optional region into the crop.
/// A region that is too small fails with `Device("Region is too small. Drag at least 64 x 64.")`.
pub fn capture_rect(monitor: usize, region: Option<PxRect>) -> Result<CaptureRect, CaptureError> {
    let info = list_monitors()
        .into_iter()
        .find(|m| m.index == monitor)
        .ok_or_else(|| CaptureError::Device(format!("monitor {monitor} was not found")))?;
    let crop = match region {
        Some(r) => normalize_region(r, info.width, info.height).map_err(CaptureError::Device)?,
        None => {
            let (w, h) = even_size(info.width, info.height);
            PxRect { x: 0, y: 0, w, h }
        }
    };
    Ok(CaptureRect { monitor, crop, origin: (info.x + crop.x, info.y + crop.y) })
}

#[derive(Debug, Default)]
pub struct ScreenStats {
    /// Every WGC frame, warm-up included.
    pub frames_seen: AtomicU64,
    /// Frames handed to the writer.
    pub frames_sent: AtomicU64,
    /// Second WGC frame in an already sent slot (screen refresh above the target fps).
    pub merged: AtomicU64,
    /// Frames dropped because the writer queue was full (retried in the same slot).
    pub dropped_full: AtomicU64,
    /// Frames that could not be copied (GPU map failed, or a frame smaller than the crop).
    pub copy_failed: AtomicU64,
    /// GPU to CPU copy time, summed over `frames_copied` (hns), and the worst one.
    pub copy_sum_hns: AtomicU64,
    pub copy_max_hns: AtomicU64,
    pub frames_copied: AtomicU64,
    /// QPC now minus the frame timestamp at arrival (hns): sum over `frames_seen` (0 for frames
    /// stamped ahead of now), and the worst.
    pub latency_sum_hns: AtomicU64,
    pub latency_max_hns: AtomicU64,
    /// Largest amount a frame timestamp was ahead of QPC now at arrival (hns).
    pub ahead_max_hns: AtomicU64,
    /// Longest time between two WGC frames (hns).
    pub max_gap_hns: AtomicU64,
}

/// Shared between the session and the WGC thread. See the `win` module docs.
pub struct ScreenShared {
    pub clock: SharedClock,
    /// Set on the first WGC frame, before t0 too.
    pub warm: AtomicBool,
    /// Recording time (hns) of output slot 0; `i64::MIN` until the first frame is sent.
    first_rec_hns: AtomicI64,
    /// The latest frame seen before t0 (cropped). WGC sends nothing while the screen is static, so
    /// when no frame arrives after t0 the session writes this one as slot 0.
    warm_frame: Mutex<Option<Vec<u8>>>,
    /// Test hook: frames after t0 are ignored, as if the screen were static (`--simulate-static-screen`).
    simulate_static: AtomicBool,
    pub stats: ScreenStats,
    pub warn: Warnings,
}

impl ScreenShared {
    pub fn new(clock: SharedClock, warn: Warnings) -> Arc<Self> {
        Arc::new(Self {
            clock,
            warm: AtomicBool::new(false),
            first_rec_hns: AtomicI64::new(i64::MIN),
            warm_frame: Mutex::new(None),
            simulate_static: AtomicBool::new(false),
            stats: ScreenStats::default(),
            warn,
        })
    }

    pub fn is_warm(&self) -> bool {
        self.warm.load(Ordering::SeqCst)
    }

    /// Recording time of the video's first frame (slot 0) in microseconds: `tracks.screen.offsetUs`.
    /// None until a frame was sent.
    pub fn first_rec_us(&self) -> Option<i64> {
        match self.first_rec_hns.load(Ordering::SeqCst) {
            i64::MIN => None,
            hns => Some(hns / 10),
        }
    }

    /// Ignore every frame after t0 from now on, as WGC does on a static screen. For tests: a
    /// static desktop cannot be guaranteed on a machine in use.
    pub fn simulate_static(&self) {
        self.simulate_static.store(true, Ordering::SeqCst);
    }

    /// Take the latest pre-t0 frame (see `warm_frame`). Call after the capture stopped.
    pub(crate) fn take_warm_frame(&self) -> Option<Vec<u8>> {
        self.warm_frame.lock().ok()?.take()
    }
}

struct Flags {
    shared: Arc<ScreenShared>,
    crop: PxRect,
    fps: u32,
    ends: CaptureEnds,
}

struct Handler {
    f: Flags,
    slotter: Slotter,
    /// A buffer that came back from a failed send, used before asking the pool.
    spare: Option<Vec<u8>>,
    size_warned: bool,
    last_ts: Option<i64>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let fps = ctx.flags.fps;
        Ok(Self { f: ctx.flags, slotter: Slotter::new(fps), spare: None, size_warned: false, last_ts: None })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
        let sh = self.f.shared.clone();
        sh.stats.frames_seen.fetch_add(1, Ordering::Relaxed);
        sh.warm.store(true, Ordering::SeqCst);
        let Ok(ts) = frame.timestamp().map(|t| t.Duration) else {
            sh.stats.copy_failed.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        };
        let late = qpc_hns() - ts;
        sh.stats.ahead_max_hns.fetch_max((-late).max(0) as u64, Ordering::Relaxed);
        let latency = late.max(0) as u64;
        sh.stats.latency_sum_hns.fetch_add(latency, Ordering::Relaxed);
        sh.stats.latency_max_hns.fetch_max(latency, Ordering::Relaxed);
        if let Some(prev) = self.last_ts.replace(ts) {
            sh.stats.max_gap_hns.fetch_max((ts - prev).max(0) as u64, Ordering::Relaxed);
        }
        let Some(rec) = rec_hns(&sh.clock, ts) else {
            // Warm-up (clock not set yet): keep the latest frame for a static-screen recording.
            if sh.clock.lock().is_ok_and(|c| c.is_none()) {
                self.keep_warm_frame(frame);
            }
            return Ok(()); // warm-up, or paused
        };
        if sh.simulate_static.load(Ordering::SeqCst) {
            return Ok(());
        }
        let Some(idx) = self.slotter.slot_for(rec) else {
            sh.stats.merged.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        };
        let c = self.f.crop;
        if frame.width() < c.x as u32 + c.w || frame.height() < c.y as u32 + c.h {
            sh.stats.copy_failed.fetch_add(1, Ordering::Relaxed);
            if !self.size_warned {
                self.size_warned = true;
                let _ = sh.warn.send("The screen size changed. The video holds the last frame.".to_string());
            }
            return Ok(());
        }
        let mut buf = self.spare.take().or_else(|| self.f.ends.pool.try_recv().ok()).unwrap_or_default();
        let copy_start = qpc_hns();
        if copy_crop(frame, c, &mut buf).is_err() {
            sh.stats.copy_failed.fetch_add(1, Ordering::Relaxed);
            self.spare = Some(buf);
            return Ok(());
        }
        let copy = (qpc_hns() - copy_start).max(0) as u64;
        sh.stats.copy_sum_hns.fetch_add(copy, Ordering::Relaxed);
        sh.stats.copy_max_hns.fetch_max(copy, Ordering::Relaxed);
        sh.stats.frames_copied.fetch_add(1, Ordering::Relaxed);
        match self.f.ends.frames.try_send((idx, buf)) {
            Ok(()) => {
                self.slotter.commit(idx);
                sh.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
                if sh.first_rec_hns.load(Ordering::Relaxed) == i64::MIN
                    && let Some(slot0) = self.slotter.first_rec_hns()
                {
                    // Exact time of slot 0, even if the slot 0 frame itself was not sent.
                    sh.first_rec_hns.store(slot0, Ordering::SeqCst);
                }
            }
            Err(TrySendError::Full((_, b))) => {
                sh.stats.dropped_full.fetch_add(1, Ordering::Relaxed);
                self.spare = Some(b);
            }
            Err(TrySendError::Disconnected((_, b))) => self.spare = Some(b), // writer gone; session reports it
        }
        Ok(())
    }
}

impl Handler {
    /// Copy the crop of a warm-up frame into `ScreenShared::warm_frame`, reusing its buffer.
    fn keep_warm_frame(&mut self, frame: &mut Frame) {
        let c = self.f.crop;
        if frame.width() < c.x as u32 + c.w || frame.height() < c.y as u32 + c.h {
            return;
        }
        let Ok(mut slot) = self.f.shared.warm_frame.lock() else { return };
        let mut buf = slot.take().unwrap_or_default();
        if copy_crop(frame, c, &mut buf).is_ok() {
            *slot = Some(buf);
        }
    }
}

/// Copy the crop rows out of the mapped frame into `buf` (tightly packed, no row padding).
fn copy_crop(frame: &mut Frame, c: PxRect, buf: &mut Vec<u8>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut fb = frame.buffer()?;
    let pitch = fb.row_pitch() as usize;
    let raw = fb.as_raw_buffer();
    let row = c.w as usize * BYTES_PER_PIXEL;
    buf.clear();
    buf.reserve(row * c.h as usize);
    for y in 0..c.h as usize {
        let start = (c.y as usize + y) * pitch + c.x as usize * BYTES_PER_PIXEL;
        let src = raw.get(start..start + row).ok_or("frame buffer is smaller than the crop")?;
        buf.extend_from_slice(src);
    }
    Ok(())
}

/// A running WGC capture.
pub struct ScreenHandle {
    control: CaptureControl<Handler, Box<dyn std::error::Error + Send + Sync>>,
}

/// Start capturing `rect` (from `capture_rect`) at `fps`. Frames are thrown away until the clock is
/// set; `shared.warm` turns on with the first frame.
pub fn start(rect: CaptureRect, fps: u32, ends: CaptureEnds, shared: Arc<ScreenShared>) -> Result<ScreenHandle, CaptureError> {
    set_dpi_awareness();
    let monitor = monitor_at(rect.monitor).ok_or_else(|| CaptureError::Device(format!("monitor {} was not found", rect.monitor)))?;
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        // Half a frame: the OS default (~16.7 ms) snaps to every 3rd refresh on a 165 Hz screen = 55 fps.
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(500_000 / fps.max(1) as u64)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        Flags { shared, crop: rect.crop, fps, ends },
    );
    let control = Handler::start_free_threaded(settings).map_err(|e| CaptureError::Device(format!("screen capture did not start: {e}")))?;
    Ok(ScreenHandle { control })
}

impl ScreenHandle {
    /// Stop WGC and join its thread. This drops the frame sender, which ends `writer::run_writer`'s loop.
    pub fn stop(self) -> Result<(), CaptureError> {
        self.control.stop().map_err(|e| CaptureError::Device(format!("screen capture did not stop cleanly: {e}")))
    }
}
