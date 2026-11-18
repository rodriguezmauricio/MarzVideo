//! Windows capture parts: screen (WGC), mic (WASAPI), input events and hotkeys, window exclusion.
//!
//! # How a session wires these modules
//!
//! Every capture thread follows one pattern:
//!
//! - **`XxxShared`** (`ScreenShared`, `MicShared`, `InputShared`) is created by the session with
//!   `XxxShared::new(..)`, held in an `Arc`, and passed to `xxx::start`. It holds only what the
//!   session and the thread both touch while recording: the shared recording clock, flags
//!   (`warm`, `muted`), published values (mic `level`, screen offset), the events log, and the
//!   outgoing [`Warnings`] (and, for input, the hotkey sender). The session reads and writes it
//!   directly; there is no command channel except `InputHandle::set_hotkeys_enabled`.
//! - **`xxx::start(..) -> Result<XxxHandle, CaptureError>`** spawns the thread, waits until the
//!   device or hook is set up, and returns an error if that failed (nothing keeps running then).
//! - **`XxxHandle::stop(self)`** stops the thread, joins it and returns what the session needs to
//!   finish the files. Stop flags are private to the handle.
//!
//! The recording clock is one [`SharedClock`] for all threads: `None` until the session takes t0
//! and stores `Some(RecClock::new(t0))`; pause and resume go through the same mutex. While it is
//! `None` (warm-up) every thread throws its data away but still sets its `warm` flag. Lock order:
//! take the clock, release it, then take anything else (the events log). Never hold both.
//!
//! Warnings are user-facing sentences sent on a [`Warnings`] channel; the session forwards them as
//! `SessionEvent::Warning`. A warning never stops the recording.

pub mod camera;
pub mod exclude;
pub mod input;
pub mod mic;
pub mod monitors;
pub mod qpc;
pub mod screen;
pub mod session;
pub mod sync_probe;

use std::sync::{mpsc, Arc, Mutex, Once};

use crate::clock::RecClock;

/// The recording clock shared by every capture thread. `None` until t0.
pub type SharedClock = Arc<Mutex<Option<RecClock>>>;

/// User-facing warning sentences, e.g. "Microphone disconnected. Recording continues without sound."
pub type Warnings = mpsc::Sender<String>;

/// A new, unset clock.
pub fn new_clock() -> SharedClock {
    Arc::new(Mutex::new(None))
}

/// Recording time for a QPC timestamp, or None before t0, while paused, or before the clock is set.
pub(crate) fn rec_hns(clock: &SharedClock, qpc_hns: i64) -> Option<i64> {
    clock.lock().ok()?.as_ref()?.rec_hns(qpc_hns)
}

/// Per-monitor DPI awareness v2 for the whole process, so monitor sizes, origins and cursor
/// positions are physical pixels. Safe to call more than once.
pub fn set_dpi_awareness() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        // Fails if the process (e.g. a manifest) already set it; that is fine.
        let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    });
}
