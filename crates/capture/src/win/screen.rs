//! Screen capture with Windows Graphics Capture (the spike's proven settings) and the constant
//! frame rate writer thread.
//!
//! Flow: WGC frame, then `RecClock::rec_hns`, then `Slotter::slot_for`, then the region is copied
//! out of the mapped frame into a pooled buffer, then `try_send` to the writer, and `commit` only
//! when the send worked (a frame dropped on a full channel is retried in its slot). The writer
//! (`run_writer`) feeds a `CfrWriter` and sends every replaced buffer back to the pool, so steady
//! state allocates nothing.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};

use super::monitors::{list_monitors, monitor_at};
use super::{rec_hns, set_dpi_awareness, SharedClock, Warnings};
use crate::region::{even_size, normalize_region, PxRect};
use crate::slots::{CfrWriter, FrameSink, Slotter};
use crate::CaptureError;

/// Frames in flight between capture and writer (the spike's queue depth).
pub const QUEUE_FRAMES: usize = 6;

const BYTES_PER_PIXEL: usize = 4; // BGRA8

/// One output frame: slot index and tightly packed BGRA pixels.
pub type SlotFrame = (u64, Vec<u8>);

/// What `screen::start` needs: frames out, recycled buffers in.
pub struct CaptureEnds {
    frames: SyncSender<SlotFrame>,
    pool: Receiver<Vec<u8>>,
}

/// What `run_writer` needs: frames in, recycled buffers out.
pub struct WriterEnds {
    frames: Receiver<SlotFrame>,
    pool: Sender<Vec<u8>>,
}

/// The frame channel (depth 6) and the buffer pool channel between capture and writer.
pub fn frame_pipe() -> (CaptureEnds, WriterEnds) {
    let (frames_tx, frames_rx) = mpsc::sync_channel::<SlotFrame>(QUEUE_FRAMES);
    let (pool_tx, pool_rx) = mpsc::channel::<Vec<u8>>();
    (CaptureEnds { frames: frames_tx, pool: pool_rx }, WriterEnds { frames: frames_rx, pool: pool_tx })
}

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
}

/// Shared between the session and the WGC thread. See the `win` module docs.
pub struct ScreenShared {
    pub clock: SharedClock,
    /// Set on the first WGC frame, before t0 too.
    pub warm: AtomicBool,
    /// Recording time (hns) of output slot 0; `i64::MIN` until the first frame is sent.
    first_rec_hns: AtomicI64,
    pub stats: ScreenStats,
    pub warn: Warnings,
}

impl ScreenShared {
    pub fn new(clock: SharedClock, warn: Warnings) -> Arc<Self> {
        Arc::new(Self {
            clock,
            warm: AtomicBool::new(false),
            first_rec_hns: AtomicI64::new(i64::MIN),
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
    frame_hns: f64,
    /// A buffer that came back from a failed send, used before asking the pool.
    spare: Option<Vec<u8>>,
    size_warned: bool,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let fps = ctx.flags.fps;
        Ok(Self { f: ctx.flags, slotter: Slotter::new(fps), frame_hns: 10_000_000.0 / fps as f64, spare: None, size_warned: false })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
        let sh = self.f.shared.clone();
        sh.stats.frames_seen.fetch_add(1, Ordering::Relaxed);
        sh.warm.store(true, Ordering::SeqCst);
        let Ok(ts) = frame.timestamp().map(|t| t.Duration) else {
            sh.stats.copy_failed.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        };
        let Some(rec) = rec_hns(&sh.clock, ts) else {
            return Ok(()); // warm-up, or paused
        };
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
        if copy_crop(frame, c, &mut buf).is_err() {
            sh.stats.copy_failed.fetch_add(1, Ordering::Relaxed);
            self.spare = Some(buf);
            return Ok(());
        }
        match self.f.ends.frames.try_send((idx, buf)) {
            Ok(()) => {
                self.slotter.commit(idx);
                sh.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
                if sh.first_rec_hns.load(Ordering::Relaxed) == i64::MIN {
                    // Time of slot 0, so offsetUs stays exact even if slot 0 itself was dropped.
                    let slot0 = rec - (idx as f64 * self.frame_hns).round() as i64;
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
    /// Stop WGC and join its thread. This drops the frame sender, which ends `run_writer`'s loop.
    pub fn stop(self) -> Result<(), CaptureError> {
        self.control.stop().map_err(|e| CaptureError::Device(format!("screen capture did not stop cleanly: {e}")))
    }
}

#[derive(Debug, Default)]
pub struct WriterStats {
    /// Frames written to the sink, repeats included.
    pub written: AtomicU64,
    /// Repeats of the previous frame (gaps and the pad to the end).
    pub repeated: AtomicU64,
    /// Set when a sink write failed (FFmpeg died); the writer stops taking frames.
    pub failed: AtomicBool,
}

/// Lets `CfrWriter` borrow the sink, so `run_writer` can hand it back for `ScreenEncoder::finish`.
struct ByRef<'a, S: FrameSink>(&'a mut S);

impl<S: FrameSink> FrameSink for ByRef<'_, S> {
    fn write(&mut self, frame: &[u8]) -> io::Result<()> {
        self.0.write(frame)
    }
}

/// `end_idx` value meaning "stop time not known yet".
pub const END_UNSET: u64 = u64::MAX;

/// The shared last-slot index for `run_writer`, starting unset.
pub fn new_end_idx() -> Arc<AtomicU64> {
    Arc::new(AtomicU64::new(END_UNSET))
}

/// The writer thread body: writes frames at a constant rate until the capture side is stopped,
/// then pads with the last frame up to and including slot `end_idx`. `end_idx` starts at
/// `END_UNSET` (`new_end_idx`); the session stores the real value before `ScreenHandle::stop`
/// (`Slotter::end_index(duration_us - screen offsetUs)`). Frames after it (they arrive while WGC
/// stops) are discarded, so the video is exactly `end_idx + 1` frames.
/// Returns the sink (always, so the session can finish or kill FFmpeg) and the first write error.
pub fn run_writer<S: FrameSink>(ends: WriterEnds, mut sink: S, end_idx: Arc<AtomicU64>, stats: Arc<WriterStats>) -> (S, io::Result<()>) {
    let result = (|| {
        let mut w = CfrWriter::new(ByRef(&mut sink));
        // Write a frame only once the next one arrived (or capture stopped): a frame in the last
        // half-slot before the stop time rounds to `end + 1` and can arrive before the end is known.
        let mut pending: Option<SlotFrame> = None;
        let write = |w: &mut CfrWriter<_>, (idx, px): SlotFrame| -> io::Result<()> {
            if idx > end_idx.load(Ordering::SeqCst) {
                let _ = ends.pool.send(px);
                return Ok(());
            }
            let (repeats, old) = w.push_recycle(idx, px)?;
            stats.written.fetch_add(repeats + 1, Ordering::Relaxed);
            stats.repeated.fetch_add(repeats, Ordering::Relaxed);
            if let Some(old) = old {
                let _ = ends.pool.send(old);
            }
            Ok(())
        };
        for frame in ends.frames.iter() {
            if let Some(prev) = pending.replace(frame) {
                write(&mut w, prev)?;
            }
        }
        if let Some(last) = pending.take() {
            write(&mut w, last)?;
        }
        let end = end_idx.load(Ordering::SeqCst);
        let repeats = if end == END_UNSET { 0 } else { w.finish(end)? };
        stats.written.fetch_add(repeats, Ordering::Relaxed);
        stats.repeated.fetch_add(repeats, Ordering::Relaxed);
        Ok(())
    })();
    if result.is_err() {
        stats.failed.store(true, Ordering::SeqCst);
    }
    // `ends` drops here: the capture side sees Disconnected and stops sending.
    (sink, result)
}
