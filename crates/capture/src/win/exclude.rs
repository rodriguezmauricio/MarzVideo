//! Keep our own windows (recorder toolbar) out of the capture.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

use crate::CaptureError;

/// Hide the window `hwnd` from every screen capture (WGC included). It stays visible on screen.
pub fn exclude_from_capture(hwnd: isize) -> Result<(), CaptureError> {
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut core::ffi::c_void), WDA_EXCLUDEFROMCAPTURE) }
        .map_err(|e| CaptureError::Device(format!("could not exclude the window from capture: {e}")))
}
