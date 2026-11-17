//! QueryPerformanceCounter time and GUIDs.

use std::sync::OnceLock;

use windows::Win32::System::Com::CoCreateGuid;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

fn qpc_freq() -> i64 {
    static FREQ: OnceLock<i64> = OnceLock::new();
    *FREQ.get_or_init(|| {
        let mut f = 0i64;
        // Cannot fail on Windows XP and later.
        let _ = unsafe { QueryPerformanceFrequency(&mut f) };
        f.max(1)
    })
}

/// QPC now, in 100 ns ticks: the unit WGC `SystemRelativeTime` and WASAPI `u64QPCPosition` use.
pub fn qpc_hns() -> i64 {
    let mut c = 0i64;
    let _ = unsafe { QueryPerformanceCounter(&mut c) };
    (i128::from(c) * 10_000_000 / i128::from(qpc_freq())) as i64
}

/// A random GUID, lowercase 8-4-4-4-12 (the `project.json` id).
pub fn new_guid() -> String {
    let g = unsafe { CoCreateGuid() }.unwrap_or_default();
    let d = g.data4;
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        g.data1, g.data2, g.data3, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]
    )
}
