//! Cursor shape for `cursorShape` lines: the current cursor handle compared with the shared system
//! cursors, and its cell size in physical pixels (read once per handle).

use std::collections::HashMap;
use std::mem::size_of;

use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorInfo, GetIconInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING, HCURSOR, ICONINFO, IDC_APPSTARTING, IDC_ARROW,
    IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE,
    IDC_WAIT,
};

/// Cell size when Windows does not say (the 100% scale cursor).
const DEFAULT_PX: u32 = 32;

pub struct ShapeReader {
    system: Vec<(isize, &'static str)>,
    sizes: HashMap<isize, u32>,
}

impl ShapeReader {
    /// Load the shared system cursors once (on the input thread).
    pub fn new() -> Self {
        let ids = [
            (IDC_ARROW, "arrow"),
            (IDC_HAND, "hand"),
            (IDC_IBEAM, "ibeam"),
            (IDC_WAIT, "wait"),
            (IDC_APPSTARTING, "progress"),
            (IDC_CROSS, "cross"),
            (IDC_SIZEALL, "move"),
            (IDC_SIZENS, "sizeNS"),
            (IDC_SIZEWE, "sizeWE"),
            (IDC_SIZENWSE, "sizeNWSE"),
            (IDC_SIZENESW, "sizeNESW"),
            (IDC_NO, "no"),
            (IDC_HELP, "help"),
        ];
        let mut system = Vec::new();
        for (id, name) in ids {
            if let Ok(h) = unsafe { LoadCursorW(None, id) } {
                system.push((h.0 as isize, name));
            }
        }
        Self { system, sizes: HashMap::new() }
    }

    /// The shape name (one of `events::CURSOR_SHAPES`) and cell size now, or None when Windows does
    /// not answer.
    pub fn read(&mut self) -> Option<(&'static str, u32)> {
        let mut ci = CURSORINFO { cbSize: size_of::<CURSORINFO>() as u32, ..Default::default() };
        unsafe { GetCursorInfo(&mut ci) }.ok()?;
        if ci.flags.0 & CURSOR_SHOWING.0 == 0 || ci.hCursor.is_invalid() {
            return Some(("hidden", self.last_px()));
        }
        let key = ci.hCursor.0 as isize;
        let name = self.system.iter().find(|(h, _)| *h == key).map(|(_, n)| *n).unwrap_or("other");
        let px = *self.sizes.entry(key).or_insert_with(|| cell_px(ci.hCursor));
        Some((name, px))
    }

    fn last_px(&self) -> u32 {
        self.sizes.values().copied().max().unwrap_or(DEFAULT_PX)
    }
}

/// Width of the cursor's bitmap (colour bitmap, or the mask for monochrome cursors).
fn cell_px(h: HCURSOR) -> u32 {
    let mut info = ICONINFO::default();
    if unsafe { GetIconInfo(h.into(), &mut info) }.is_err() {
        return DEFAULT_PX;
    }
    let mut bm = BITMAP::default();
    let src = if info.hbmColor.is_invalid() { info.hbmMask } else { info.hbmColor };
    let got = unsafe { GetObjectW(HGDIOBJ(src.0), size_of::<BITMAP>() as i32, Some(&mut bm as *mut BITMAP as *mut _)) };
    unsafe {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
    }
    if got == 0 || bm.bmWidth <= 0 { DEFAULT_PX } else { bm.bmWidth as u32 }
}
