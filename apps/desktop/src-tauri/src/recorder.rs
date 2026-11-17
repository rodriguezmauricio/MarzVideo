//! The recorder setup: the `overlay` (region and zoom presets over the whole monitor) and the `bar`
//! (mic, meter, Record) windows, both kept out of the capture, plus the mic meter.
//!
//! The overlay covers the monitor the main window is on, in physical pixels. The page works in CSS
//! pixels and sends physical, monitor-relative pixels back (`check_region`). Starting a recording
//! is Task 13; `start_recording` is a stub until then.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const OVERLAY: &str = "overlay";
const BAR: &str = "bar";
/// The bar's top edge at 1440 x 900 in the design; scaled to the monitor height.
const BAR_TOP_DESIGN: f64 = 704.0;
const DESIGN_H: f64 = 900.0;

/// The monitor the recorder covers. Position and size in physical pixels.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RecMonitor {
    /// Index in `marz_capture::win::monitors::list_monitors` (what the session records).
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Mic {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// What the bar needs when it opens.
#[derive(Serialize, Clone, Debug)]
pub struct Setup {
    pub monitor: RecMonitor,
    pub mics: Vec<Mic>,
    pub ffmpeg: bool,
}

/// A rectangle in physical pixels, relative to the monitor's top-left corner.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

pub const SCREEN_NOT_FOUND: &str = "Could not find this screen. Move the window to a screen and try again.";

/// Lock order: `meter` before `monitor`. The meter lock is held across stop, start and store so
/// meter starts never overlap, and `close_all` clears the monitor under it so a start that was
/// waiting sees the recorder closed and refuses.
#[derive(Default)]
pub struct Recorder {
    monitor: Mutex<Option<RecMonitor>>,
    meter: Mutex<Option<meter::Run>>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn monitor(state: &Recorder) -> Result<RecMonitor, String> {
    state.monitor.lock().map_err(err)?.clone().ok_or_else(|| "The recorder is not open.".to_string())
}

/// Clamp `rect` to the recorder's monitor and make it even; the error is a sentence for the bar.
pub fn checked_region(rect: Rect, mon_w: u32, mon_h: u32) -> Result<Rect, String> {
    use marz_capture::region::{normalize_region, PxRect};
    let r = normalize_region(PxRect { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, mon_w, mon_h)?;
    Ok(Rect { x: r.x, y: r.y, w: r.w, h: r.h })
}

/// Where the bar window goes: centred, its bar's top edge at y 704 of 900 scaled to the monitor.
/// `w`, `h` and `bar_top` (the bar's top inside the window) are CSS pixels.
pub fn bar_placement(mon: &RecMonitor, w: f64, h: f64, bar_top: f64) -> (i32, i32, u32, u32) {
    let pw = (w * mon.scale).ceil() as u32;
    let ph = (h * mon.scale).ceil() as u32;
    let x = mon.x + (mon.width as i32 - pw as i32) / 2;
    let y = mon.y + (f64::from(mon.height) * BAR_TOP_DESIGN / DESIGN_H).round() as i32 - (bar_top * mon.scale).round() as i32;
    (x, y, pw, ph)
}

/// Init script that hands the page its monitor (the page reads `window.__MARZ_MONITOR__`).
fn init_script(mon: &RecMonitor) -> String {
    format!("window.__MARZ_MONITOR__ = {};", serde_json::to_string(mon).unwrap_or_else(|_| "null".into()))
}

/// Open the overlay and the bar on the monitor the main window is on; hide the main window.
#[tauri::command]
pub async fn open_recorder(app: AppHandle, state: State<'_, Recorder>) -> Result<(), String> {
    if app.get_webview_window(OVERLAY).is_some() {
        return Ok(());
    }
    let main = app.get_webview_window("main").ok_or("The main window is missing.")?;
    let tmon = match main.current_monitor().map_err(err)? {
        Some(m) => m,
        None => main.primary_monitor().map_err(err)?.ok_or("No monitor was found.")?,
    };
    let (pos, size) = (*tmon.position(), *tmon.size());
    let index = platform::capture_index(pos.x, pos.y).ok_or(SCREEN_NOT_FOUND)?;
    let mon = RecMonitor {
        index,
        name: tmon.name().cloned().unwrap_or_else(|| format!("Display {}", index + 1)),
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        scale: tmon.scale_factor(),
    };
    *state.monitor.lock().map_err(err)? = Some(mon.clone());
    match build_windows(&app, &mon) {
        Ok(overlay) => {
            // If the overlay goes away by any route (Alt+F4 too), the recorder closes and Home comes back.
            let handle = app.clone();
            overlay.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    close_all(&handle);
                }
            });
            overlay.show().map_err(err)?;
            main.hide().map_err(err)?;
            Ok(())
        }
        Err(e) => {
            // Leave nothing half open, so the next open_recorder starts clean.
            for label in [BAR, OVERLAY] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.destroy();
                }
            }
            if let Ok(mut m) = state.monitor.lock() {
                *m = None;
            }
            Err(e)
        }
    }
}

/// Build the overlay and the bar, both excluded from capture right after creation.
fn build_windows(app: &AppHandle, mon: &RecMonitor) -> Result<WebviewWindow, String> {
    let overlay = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("recorder.html".into()))
        .title("Marz Recorder region")
        .initialization_script(init_script(mon))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(err)?;
    platform::exclude(&overlay)?;
    overlay.set_position(tauri::PhysicalPosition::new(mon.x, mon.y)).map_err(err)?;
    overlay.set_size(tauri::PhysicalSize::new(mon.width, mon.height)).map_err(err)?;

    let bar = WebviewWindowBuilder::new(app, BAR, WebviewUrl::App("bar.html".into()))
        .title("Marz Recorder")
        .initialization_script(init_script(mon))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(err)?;
    platform::exclude(&bar)?;
    // The bar shows itself once it knows its size (`fit_bar`).
    let (x, y, w, h) = bar_placement(mon, 900.0, 110.0, 24.0);
    bar.set_position(tauri::PhysicalPosition::new(x, y)).map_err(err)?;
    bar.set_size(tauri::PhysicalSize::new(w, h)).map_err(err)?;

    Ok(overlay)
}

fn close_all(app: &AppHandle) {
    let state = app.state::<Recorder>();
    {
        let mut meter = state.meter.lock().unwrap_or_else(|p| p.into_inner());
        meter::stop(&mut meter);
        if let Ok(mut m) = state.monitor.lock() {
            *m = None;
        }
    }
    for label in [BAR, OVERLAY] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Close both recorder windows and show the main window again.
#[tauri::command]
pub fn close_recorder(app: AppHandle) {
    close_all(&app);
}

/// Monitor, microphones and whether FFmpeg was found.
#[tauri::command(async)]
pub fn recorder_setup(state: State<'_, Recorder>) -> Result<Setup, String> {
    Ok(Setup { monitor: monitor(&state)?, mics: list_mics(), ffmpeg: marz_capture::ffmpeg::find_ffmpeg().is_ok() })
}

/// Active microphones.
#[tauri::command(async)]
pub fn list_mics() -> Vec<Mic> {
    platform::mics()
}

/// The region clamped to the monitor and made even, or the sentence to show.
#[tauri::command]
pub fn check_region(state: State<'_, Recorder>, rect: Rect) -> Result<Rect, String> {
    let mon = monitor(&state)?;
    checked_region(rect, mon.width, mon.height)
}

/// Size and place the bar window around its content, then show it.
#[tauri::command]
pub fn fit_bar(window: WebviewWindow, state: State<'_, Recorder>, w: f64, h: f64, bar_top: f64) -> Result<(), String> {
    let mon = monitor(&state)?;
    let (x, y, pw, ph) = bar_placement(&mon, w, h, bar_top);
    window.set_size(tauri::PhysicalSize::new(pw, ph)).map_err(err)?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(err)?;
    window.show().map_err(err)
}

/// Open `mic_id` (None = default) for the meter; emits `recorder://level` (0..1) to the bar every 50 ms.
#[tauri::command(async)]
pub fn start_mic_meter(app: AppHandle, state: State<'_, Recorder>, mic_id: Option<String>) -> Result<(), String> {
    let mut meter = state.meter.lock().map_err(err)?;
    meter::stop(&mut meter);
    monitor(&state)?; // closed recorder: no meter
    *meter = Some(meter::start(app, mic_id)?);
    Ok(())
}

#[tauri::command(async)]
pub fn stop_mic_meter(state: State<'_, Recorder>) {
    meter::stop(&mut state.meter.lock().unwrap_or_else(|p| p.into_inner()));
}

/// Stub until Task 13 wires the session. Stops the meter as the real start will.
#[tauri::command(async)]
pub fn start_recording(state: State<'_, Recorder>) -> Result<(), String> {
    meter::stop(&mut *state.meter.lock().map_err(err)?);
    Err("Recording is wired in the next step.".into())
}

#[cfg(windows)]
mod platform {
    use super::Mic;
    use marz_capture::win::{exclude::exclude_from_capture, mic::list_mics, monitors::list_monitors};
    use tauri::WebviewWindow;

    pub fn capture_index(x: i32, y: i32) -> Option<usize> {
        list_monitors().into_iter().find(|m| m.x == x && m.y == y).map(|m| m.index)
    }

    pub fn exclude(w: &WebviewWindow) -> Result<(), String> {
        let hwnd = w.hwnd().map_err(|e| e.to_string())?;
        exclude_from_capture(hwnd.0 as isize).map_err(|e| e.to_string())
    }

    pub fn mics() -> Vec<Mic> {
        list_mics().into_iter().map(|m| Mic { id: m.id, name: m.name, default: m.default }).collect()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Mic;
    use tauri::WebviewWindow;

    pub fn capture_index(_x: i32, _y: i32) -> Option<usize> {
        None
    }

    pub fn exclude(_w: &WebviewWindow) -> Result<(), String> {
        Err("The recorder needs Windows.".into())
    }

    pub fn mics() -> Vec<Mic> {
        Vec::new()
    }
}

mod meter {
    use super::BAR;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    #[cfg(windows)]
    use std::time::Duration;
    #[cfg(windows)]
    use tauri::{AppHandle, Emitter};

    /// Meter threads alive right now (logged in debug builds, to catch leaks).
    static LIVE: AtomicUsize = AtomicUsize::new(0);

    /// One running meter. Dropping it stops and joins the thread, so a replaced run never leaks.
    pub struct Run {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Run {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// Stop the run in `slot`, if any (the caller holds the meter lock).
    pub fn stop(slot: &mut Option<Run>) {
        drop(slot.take());
    }

    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn live() -> usize {
        LIVE.load(Ordering::SeqCst)
    }

    #[cfg(windows)]
    pub fn start(app: AppHandle, mic_id: Option<String>) -> Result<Run, String> {
        let handle = marz_capture::win::mic::start_meter(mic_id.as_deref()).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        LIVE.fetch_add(1, Ordering::SeqCst);
        #[cfg(debug_assertions)]
        eprintln!("marz-meter: started, live runs {}", live());
        let thread = std::thread::Builder::new()
            .name("marz-meter".into())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    let level = if handle.lost() { 0.0 } else { handle.level() };
                    let _ = app.emit_to(BAR, "recorder://level", level);
                    std::thread::sleep(Duration::from_millis(50));
                }
                handle.stop();
                LIVE.fetch_sub(1, Ordering::SeqCst);
                #[cfg(debug_assertions)]
                eprintln!("marz-meter: stopped, live runs {}", live());
            })
            .map_err(|e| {
                LIVE.fetch_sub(1, Ordering::SeqCst);
                e.to_string()
            })?;
        Ok(Run { stop, thread: Some(thread) })
    }

    #[cfg(not(windows))]
    pub fn start(_app: tauri::AppHandle, _mic_id: Option<String>) -> Result<Run, String> {
        Err("The microphone meter needs Windows.".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_replaced_or_stopped_run_ends_its_thread() {
            let ended = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let (flag, done) = (stop.clone(), ended.clone());
            let thread = std::thread::spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
                done.store(true, Ordering::SeqCst);
            });
            let mut slot = Some(Run { stop, thread: Some(thread) });
            stop_slot_for_test(&mut slot);
            assert!(slot.is_none());
            assert!(ended.load(Ordering::SeqCst), "the thread was joined");
        }

        fn stop_slot_for_test(slot: &mut Option<Run>) {
            stop(slot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(scale: f64) -> RecMonitor {
        RecMonitor { index: 0, name: "Test".into(), x: -2880, y: 0, width: 2880, height: 1800, scale }
    }

    #[test]
    fn region_is_clamped_made_even_and_refused_when_small() {
        let r = checked_region(Rect { x: 2800, y: 101, w: 500, h: 301 }, 2880, 1800).unwrap();
        assert_eq!(r, Rect { x: 2800, y: 101, w: 80, h: 300 });
        assert_eq!(
            checked_region(Rect { x: 0, y: 0, w: 40, h: 400 }, 2880, 1800),
            Err("Region is too small. Drag at least 64 x 64.".to_string())
        );
    }

    #[test]
    fn bar_sits_centred_at_704_of_900_scaled_to_the_monitor() {
        // 1440 x 900 at 100%: the design position exactly
        let m = RecMonitor { x: 0, width: 1440, height: 900, scale: 1.0, ..mon(1.0) };
        assert_eq!(bar_placement(&m, 800.0, 100.0, 24.0), (320, 680, 800, 100));
        // 2880 x 1800 at 200%, left of the primary: same place in logical pixels
        assert_eq!(bar_placement(&mon(2.0), 800.0, 100.0, 24.0), (-2880 + 640, 1408 - 48, 1600, 200));
    }
}
