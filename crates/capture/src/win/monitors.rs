//! Monitor list for the recorder setup.

use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows_capture::monitor::Monitor;

use super::set_dpi_awareness;

/// Monitor flag for the primary monitor (`MONITORINFOF_PRIMARY`).
const PRIMARY: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorInfo {
    /// Position in `list_monitors()`, 0-based. Pass this to `screen::start`.
    pub index: usize,
    pub name: String,
    /// Top-left in virtual-screen physical pixels (the events origin for a full-monitor capture).
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub primary: bool,
}

/// The monitors in `EnumDisplayMonitors` order, which is also the order `screen::start` uses.
pub fn list_monitors() -> Vec<MonitorInfo> {
    set_dpi_awareness();
    let Ok(all) = Monitor::enumerate() else { return Vec::new() };
    all.iter()
        .enumerate()
        .map(|(index, m)| {
            let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
            let _ = unsafe { GetMonitorInfoW(HMONITOR(m.as_raw_hmonitor()), &mut mi) };
            let r = mi.rcMonitor;
            MonitorInfo {
                index,
                name: m.name().ok().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("Display {}", index + 1)),
                x: r.left,
                y: r.top,
                width: m.width().unwrap_or((r.right - r.left).max(0) as u32),
                height: m.height().unwrap_or((r.bottom - r.top).max(0) as u32),
                refresh_hz: m.refresh_rate().unwrap_or(0),
                primary: mi.dwFlags & PRIMARY != 0,
            }
        })
        .collect()
}

/// The `windows_capture` monitor at `index` (0-based, as in `list_monitors`).
pub(crate) fn monitor_at(index: usize) -> Option<Monitor> {
    Monitor::enumerate().ok()?.get(index).copied()
}
