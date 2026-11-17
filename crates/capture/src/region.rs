//! Capture region math (cross-platform, pure): clamp a dragged rectangle to its monitor and make
//! every size handed to FFmpeg even.

/// A rectangle in physical pixels, relative to the monitor's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Smallest region accepted, in pixels per side.
pub const MIN_REGION: u32 = 64;

pub const REGION_TOO_SMALL: &str = "Region is too small. Drag at least 64 x 64.";

/// Width and height rounded down to even (H.264 with 4:2:0 needs even sizes).
pub fn even_size(w: u32, h: u32) -> (u32, u32) {
    (w & !1, h & !1)
}

/// Clamp `r` to a `monitor_w` x `monitor_h` monitor, round width and height down to even, and
/// refuse anything below 64 x 64.
pub fn normalize_region(r: PxRect, monitor_w: u32, monitor_h: u32) -> Result<PxRect, String> {
    // Clamp each axis to [0, monitor size) in i64 so huge or negative inputs cannot overflow.
    let clamp = |start: i32, len: u32, size: u32| -> (i64, i64) {
        let a = i64::from(start).clamp(0, i64::from(size));
        let b = (i64::from(start) + i64::from(len)).clamp(0, i64::from(size));
        (a, (b - a).max(0))
    };
    let (x, w) = clamp(r.x, r.w, monitor_w);
    let (y, h) = clamp(r.y, r.h, monitor_h);
    let (w, h) = even_size(w as u32, h as u32);
    if w < MIN_REGION || h < MIN_REGION {
        return Err(REGION_TOO_SMALL.to_string());
    }
    Ok(PxRect { x: x as i32, y: y as i32, w, h })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MW: u32 = 1920;
    const MH: u32 = 1080;

    fn rect(x: i32, y: i32, w: u32, h: u32) -> PxRect {
        PxRect { x, y, w, h }
    }

    #[test]
    fn odd_size_rounds_down_to_even() {
        assert_eq!(normalize_region(rect(101, 101, 1001, 563), MW, MH), Ok(rect(101, 101, 1000, 562)));
    }

    #[test]
    fn off_the_right_edge_is_clamped() {
        // 1800 + 400 runs 280 px past the 1920 px edge
        assert_eq!(normalize_region(rect(1800, 100, 400, 300), MW, MH), Ok(rect(1800, 100, 120, 300)));
        // and off the bottom, with an odd remainder
        assert_eq!(normalize_region(rect(0, 900, 200, 400), MW, 1081), Ok(rect(0, 900, 200, 180)));
    }

    #[test]
    fn off_the_left_and_top_edge_is_clamped() {
        assert_eq!(normalize_region(rect(-50, -20, 300, 200), MW, MH), Ok(rect(0, 0, 250, 180)));
    }

    #[test]
    fn too_small_is_refused_with_the_exact_message() {
        assert_eq!(normalize_region(rect(10, 10, 40, 40), MW, MH), Err("Region is too small. Drag at least 64 x 64.".to_string()));
        // big enough before clamping, too small after
        assert_eq!(normalize_region(rect(1900, 10, 200, 200), MW, MH), Err(REGION_TOO_SMALL.to_string()));
        // fully outside the monitor
        assert_eq!(normalize_region(rect(5000, 10, 200, 200), MW, MH), Err(REGION_TOO_SMALL.to_string()));
        // 64 x 64 itself is fine
        assert_eq!(normalize_region(rect(0, 0, 64, 64), MW, MH), Ok(rect(0, 0, 64, 64)));
    }

    #[test]
    fn full_monitor_is_unchanged() {
        assert_eq!(normalize_region(rect(0, 0, MW, MH), MW, MH), Ok(rect(0, 0, MW, MH)));
    }

    #[test]
    fn even_size_rounds_down() {
        assert_eq!(even_size(1920, 1080), (1920, 1080));
        assert_eq!(even_size(1366, 767), (1366, 766));
        assert_eq!(even_size(2561, 1441), (2560, 1440));
    }
}
