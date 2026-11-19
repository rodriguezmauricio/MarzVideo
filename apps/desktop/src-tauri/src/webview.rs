//! WebView2 switches for every window. WebCodecs only offers the hardware HEVC encoder when Chromium's
//! `PlatformHEVCEncoderSupport` feature is on (off by default in WebView2 157). All windows share one
//! browser process, so the switch is set once, before any window, through the environment variable that
//! WebView2 reads. Tauri's own default (`--disable-features=...`) is kept.

const ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
const TAURI_DEFAULT: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const HEVC: &str = "--enable-features=PlatformHEVCEncoderSupport";

/// The switches to use, given what the environment already says (tests add a CDP port there).
pub fn browser_args(existing: Option<&str>) -> String {
    match existing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(e) if e.contains("PlatformHEVCEncoderSupport") => e.to_string(),
        Some(e) if e.contains("--disable-features") => format!("{e} {HEVC}"),
        Some(e) => format!("{TAURI_DEFAULT} {e} {HEVC}"),
        None => format!("{TAURI_DEFAULT} {HEVC}"),
    }
}

/// Set the switches. Call first thing in `run`, before any thread or window exists.
pub fn set_browser_args() {
    let args = browser_args(std::env::var(ENV).ok().as_deref());
    // SAFETY: called at the start of `run`, before Tauri or any other thread starts.
    unsafe { std::env::set_var(ENV, args) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_hevc_and_keeps_tauri_default_and_test_switches() {
        assert_eq!(browser_args(None), format!("{TAURI_DEFAULT} {HEVC}"));
        assert_eq!(browser_args(Some("  ")), format!("{TAURI_DEFAULT} {HEVC}"));
        assert_eq!(browser_args(Some("--remote-debugging-port=9341")), format!("{TAURI_DEFAULT} --remote-debugging-port=9341 {HEVC}"));
        let full = format!("--remote-debugging-port=1 {HEVC}");
        assert_eq!(browser_args(Some(&full)), full);
    }
}
