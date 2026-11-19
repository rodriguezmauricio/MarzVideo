//! The recorder setup: the `overlay` (region and zoom presets over the whole monitor) and the `bar`
//! (mic, meter, Record) windows, both kept out of the capture, plus the mic meter.
//!
//! The overlay takes the mouse only over its own controls (`overlay_hits`, see `hits`): everywhere
//! else clicks go to the apps under it, before and during the recording. The bar can be dragged
//! anywhere and keeps that place until the app closes.
//!
//! The overlay covers the monitor the main window is on, in physical pixels. The page works in CSS
//! pixels and sends physical, monitor-relative pixels back (`check_region`). The recording itself
//! (session, hotkeys, stop into the editor) is in `recording.rs`.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use crate::recording::Shutdown;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const OVERLAY: &str = "overlay";
pub(crate) const BAR: &str = "bar";
/// The bar's top edge at 1440 x 900 in the design (before recording); scaled to the monitor height.
const BAR_TOP_DESIGN: f64 = 704.0;
/// The bar's top edge while recording.
const BAR_TOP_RECORDING: f64 = 716.0;
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

/// A camera for the setup bar picker. `name` also finds it in the page (`getUserMedia` labels).
#[derive(Serialize, Clone, Debug)]
pub struct Camera {
    pub id: String,
    pub name: String,
}

/// What the bar needs when it opens.
#[derive(Serialize, Clone, Debug)]
pub struct Setup {
    pub monitor: RecMonitor,
    pub mics: Vec<Mic>,
    pub cameras: Vec<Camera>,
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
    /// Where the overlay takes the mouse.
    hits: Mutex<Hits>,
    /// Bumped on every open and close, so an old hit-test thread ends.
    hit_gen: AtomicU64,
    bar: Mutex<BarPlace>,
}

/// A rectangle in physical pixels from the overlay's top-left corner.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The overlay's controls (`rects`), or the whole overlay while drawing (`grab`).
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Hits {
    pub rects: Vec<HitRect>,
    pub grab: bool,
}

impl Hits {
    /// Does the overlay take the mouse at `(x, y)` (physical pixels from its top-left)?
    pub fn takes(&self, x: f64, y: f64) -> bool {
        self.grab || self.rects.iter().any(|r| x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
    }
}

/// The bar window's place. `anchor` is set once the bar is dragged: the bar's centre x and its top
/// edge, in physical screen pixels; later fits keep it there.
#[derive(Default, Debug)]
struct BarPlace {
    /// Where the last `fit_bar` put the window (its own Moved event is not a drag).
    placed: Option<(i32, i32)>,
    /// Physical width of the window and the bar's top inside it, from the last fit.
    width: u32,
    bar_top_px: i32,
    anchor: Option<(i32, i32)>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn monitor(state: &Recorder) -> Result<RecMonitor, String> {
    state.monitor.lock().map_err(err)?.clone().ok_or_else(|| "The recorder is not open.".to_string())
}

/// The monitor the open recorder covers, or an error when the recorder is closed.
pub(crate) fn current_monitor(app: &AppHandle) -> Result<RecMonitor, String> {
    monitor(&app.state::<Recorder>())
}

/// Stop the setup mic meter (the session opens the same device).
pub(crate) fn stop_meter(app: &AppHandle) {
    meter::stop(&mut app.state::<Recorder>().meter.lock().unwrap_or_else(|p| p.into_inner()));
}

/// Clamp `rect` to the recorder's monitor and make it even; the error is a sentence for the bar.
pub fn checked_region(rect: Rect, mon_w: u32, mon_h: u32) -> Result<Rect, String> {
    use marz_capture::region::{normalize_region, PxRect};
    let r = normalize_region(PxRect { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, mon_w, mon_h)?;
    Ok(Rect { x: r.x, y: r.y, w: r.w, h: r.h })
}

/// Where the bar window goes: centred, its bar's top edge at y `design_top` of 900 (704 before
/// recording, 716 while recording) scaled to the monitor. `w`, `h` and `bar_top` (the bar's top
/// inside the window) are physical pixels: the page converts with its own pixel ratio, which can
/// differ from the monitor's scale (WebView2 also applies the Windows text size).
pub fn bar_placement(mon: &RecMonitor, w: f64, h: f64, bar_top: f64, design_top: f64) -> (i32, i32, u32, u32) {
    let pw = w.ceil() as u32;
    let ph = h.ceil() as u32;
    let x = mon.x + (mon.width as i32 - pw as i32) / 2;
    let y = mon.y + (f64::from(mon.height) * design_top / DESIGN_H).round() as i32 - bar_top.round() as i32;
    (x, y, pw, ph)
}

/// Window position for a bar dragged to `anchor` (bar centre x, bar top y), clamped so the bar
/// stays on the monitor.
pub fn anchored_placement(mon: &RecMonitor, anchor: (i32, i32), pw: u32, ph: u32, bar_top_px: i32) -> (i32, i32) {
    let x = anchor.0 - pw as i32 / 2;
    let y = anchor.1 - bar_top_px;
    let max_x = mon.x + mon.width as i32 - pw as i32;
    let max_y = mon.y + mon.height as i32 - ph as i32;
    (x.clamp(mon.x, max_x.max(mon.x)), y.clamp(mon.y, max_y.max(mon.y)))
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
            // If the overlay or the bar goes away by any route (Alt+F4 too), the recorder closes:
            // a running recording is stopped and opened, never left without a Stop. On its own
            // thread, so a stop never blocks the window thread.
            for w in [Some(overlay.clone()), app.get_webview_window(BAR)].into_iter().flatten() {
                let handle = app.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        let app = handle.clone();
                        std::thread::spawn(move || close_all(&app));
                    }
                });
            }
            if let Some(bar) = app.get_webview_window(BAR) {
                let handle = app.clone();
                bar.on_window_event(move |e| {
                    if let tauri::WindowEvent::Moved(p) = e {
                        bar_moved(&handle, p.x, p.y);
                    }
                });
            }
            if let Ok(mut h) = state.hits.lock() {
                *h = Hits::default();
            }
            hits::start(&app, state.hit_gen.fetch_add(1, Ordering::SeqCst) + 1);
            overlay.show().map_err(err)?;
            main.hide().map_err(err)?;
            crate::recording::set_open(&app, true);
            crate::recording::arm_setup_keys(&app);
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
    let (x, y, w, h) = bar_placement(mon, 900.0 * mon.scale, 110.0 * mon.scale, 24.0 * mon.scale, BAR_TOP_DESIGN);
    bar.set_position(tauri::PhysicalPosition::new(x, y)).map_err(err)?;
    bar.set_size(tauri::PhysicalSize::new(w, h)).map_err(err)?;

    Ok(overlay)
}

/// Close the recorder: meter and setup hotkeys off, a running recording stopped, both windows
/// gone, the main window back (`land`). No lock is held while windows are destroyed (their
/// Destroyed handlers call this again). A close that finds another stop running leaves the main
/// window to that stop, so Home never shows while the files are still being finished.
pub(crate) fn close_all(app: &AppHandle) -> Shutdown {
    crate::recording::set_open(app, false); // before the keys are freed: see `arm_setup_keys`
    let state = app.state::<Recorder>();
    {
        let mut meter = state.meter.lock().unwrap_or_else(|p| p.into_inner());
        meter::stop(&mut meter);
        if let Ok(mut m) = state.monitor.lock() {
            *m = None;
        }
    }
    state.hit_gen.fetch_add(1, Ordering::SeqCst);
    let stopped = crate::recording::shutdown(app);
    for label in [BAR, OVERLAY] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    land(app, &stopped);
    stopped
}

/// Back to the main window after the recorder closed: a stopped recording opens in the editor
/// (`recorder://open-project`); one whose files could not be finished shows the sentence on Home
/// (`recorder://stop-failed`) above its recover banner. `Busy`: the running stop lands instead.
pub(crate) fn land(app: &AppHandle, how: &Shutdown) {
    if *how == Shutdown::Busy {
        return;
    }
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.show();
    let _ = main.set_focus();
    match how {
        Shutdown::Stopped(Ok(dir)) => {
            let _ = main.emit_to("main", crate::recording::OPEN_EVENT, dir);
        }
        Shutdown::Stopped(Err(_)) => {
            let _ = main.emit_to("main", crate::recording::STOP_FAILED_EVENT, crate::recording::STOP_FAILED);
        }
        _ => {}
    }
}

/// Close both recorder windows and show the main window again.
#[tauri::command]
pub fn close_recorder(app: AppHandle) {
    let _ = close_all(&app);
}

/// Monitor, microphones and whether FFmpeg was found.
#[tauri::command(async)]
pub fn recorder_setup(state: State<'_, Recorder>) -> Result<Setup, String> {
    Ok(Setup { monitor: monitor(&state)?, mics: list_mics(), cameras: platform::cameras(), ffmpeg: marz_capture::ffmpeg::find_ffmpeg().is_ok() })
}

/// Active microphones.
#[tauri::command(async)]
pub fn list_mics() -> Vec<Mic> {
    platform::mics()
}

/// Cameras for the pickers (Settings and onboarding too).
pub(crate) fn list_cameras() -> Vec<Camera> {
    platform::cameras()
}

/// The region clamped to the monitor and made even, or the sentence to show.
#[tauri::command]
pub fn check_region(state: State<'_, Recorder>, rect: Rect) -> Result<Rect, String> {
    let mon = monitor(&state)?;
    checked_region(rect, mon.width, mon.height)
}

/// Size and place the bar window around its content, then show it. `recording` puts the bar at
/// the recording position (y 716 instead of 704).
/// A bar that was dragged keeps its place (centre and bar top) instead.
#[tauri::command]
pub fn fit_bar(window: WebviewWindow, state: State<'_, Recorder>, w: f64, h: f64, bar_top: f64, recording: Option<bool>) -> Result<(), String> {
    let mon = monitor(&state)?;
    let top = if recording == Some(true) { BAR_TOP_RECORDING } else { BAR_TOP_DESIGN };
    let (mut x, mut y, pw, ph) = bar_placement(&mon, w, h, bar_top, top);
    let bar_top_px = bar_top.round() as i32;
    {
        let mut place = state.bar.lock().map_err(err)?;
        if let Some(a) = place.anchor {
            (x, y) = anchored_placement(&mon, a, pw, ph, bar_top_px);
        }
        place.placed = Some((x, y));
        place.width = pw;
        place.bar_top_px = bar_top_px;
    }
    window.set_size(tauri::PhysicalSize::new(pw, ph)).map_err(err)?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(err)?;
    window.show().map_err(err)
}

/// Drag the bar window (the page calls this on a press on the bar's empty parts).
#[tauri::command]
pub fn drag_bar(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(err)
}

/// The bar window moved. A move to anywhere but where `fit_bar` put it is a drag.
fn bar_moved(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<Recorder>();
    let Ok(mut place) = state.bar.lock() else { return };
    if place.placed == Some((x, y)) || place.width == 0 {
        return;
    }
    place.placed = Some((x, y));
    place.anchor = Some((x + place.width as i32 / 2, y + place.bar_top_px));
}

/// Where the overlay takes the mouse: its controls in physical pixels from the overlay's top-left
/// (the monitor's), or everything while drawing.
#[tauri::command]
pub fn overlay_hits(state: State<'_, Recorder>, rects: Vec<HitRect>, grab: bool) -> Result<(), String> {
    *state.hits.lock().map_err(err)? = Hits { rects, grab };
    Ok(())
}

/// The hit-test thread: about 60 times a second it reads the cursor and makes the overlay
/// click-through unless the cursor is over one of its controls. Nothing changes while a mouse
/// button is held, so a drag that started on a control keeps going, and a drag in another app
/// that passes over a control is not taken over.
mod hits {
    use super::{Recorder, OVERLAY};
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    pub fn start(app: &AppHandle, generation: u64) {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("marz-overlay-hits".into()).spawn(move || {
            let mut taking: Option<bool> = None;
            loop {
                std::thread::sleep(Duration::from_millis(16));
                let state = app.state::<Recorder>();
                if state.hit_gen.load(Ordering::SeqCst) != generation {
                    break;
                }
                let Some(w) = app.get_webview_window(OVERLAY) else { break };
                let Some(mon) = state.monitor.lock().ok().and_then(|m| m.clone()) else { break };
                if platform::button_down() {
                    continue;
                }
                let Some((cx, cy)) = platform::cursor() else { continue };
                let (x, y) = (f64::from(cx - mon.x), f64::from(cy - mon.y));
                let take = state.hits.lock().map(|h| h.takes(x, y)).unwrap_or(false);
                if taking != Some(take) && w.set_ignore_cursor_events(!take).is_ok() {
                    taking = Some(take);
                }
            }
        });
    }

    #[cfg(windows)]
    mod platform {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        pub fn cursor() -> Option<(i32, i32)> {
            let mut p = POINT::default();
            unsafe { GetCursorPos(&mut p) }.ok().map(|()| (p.x, p.y))
        }

        pub fn button_down() -> bool {
            [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().any(|k| unsafe { GetAsyncKeyState(i32::from(k.0)) } as u16 & 0x8000 != 0)
        }
    }

    #[cfg(not(windows))]
    mod platform {
        pub fn cursor() -> Option<(i32, i32)> {
            None
        }
        pub fn button_down() -> bool {
            false
        }
    }
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

    pub fn cameras() -> Vec<super::Camera> {
        marz_capture::win::camera::list_cameras().into_iter().map(|c| super::Camera { id: c.id, name: c.name }).collect()
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

    pub fn cameras() -> Vec<super::Camera> {
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
    fn the_overlay_takes_the_mouse_only_over_its_controls() {
        let h = Hits { rects: vec![HitRect { x: 10.0, y: 10.0, w: 20.0, h: 5.0 }], grab: false };
        assert!(h.takes(10.0, 10.0));
        assert!(h.takes(29.9, 14.9));
        assert!(!h.takes(30.0, 12.0));
        assert!(!h.takes(500.0, 500.0));
        assert!(Hits { rects: vec![], grab: true }.takes(500.0, 500.0));
        assert!(!Hits::default().takes(0.0, 0.0));
    }

    #[test]
    fn a_dragged_bar_keeps_its_place_and_stays_on_the_monitor() {
        let m = RecMonitor { x: 0, width: 1440, height: 900, scale: 1.0, ..mon(1.0) };
        // dragged so the bar's centre is at 300 and its top at 850 (over the taskbar)
        assert_eq!(anchored_placement(&m, (300, 850), 800, 100, 24), (0, 800));
        assert_eq!(anchored_placement(&m, (720, 400), 800, 100, 24), (320, 376));
    }

    #[test]
    fn bar_sits_centred_at_704_of_900_scaled_to_the_monitor() {
        // 1440 x 900 at 100%: the design position exactly
        let m = RecMonitor { x: 0, width: 1440, height: 900, scale: 1.0, ..mon(1.0) };
        assert_eq!(bar_placement(&m, 800.0, 100.0, 24.0, BAR_TOP_DESIGN), (320, 680, 800, 100));
        // 2880 x 1800 at 200%, left of the primary: the page sends physical sizes
        assert_eq!(bar_placement(&mon(2.0), 1600.0, 200.0, 48.0, BAR_TOP_DESIGN), (-2880 + 640, 1408 - 48, 1600, 200));
        // while recording the bar's top is at 716
        assert_eq!(bar_placement(&m, 800.0, 100.0, 0.0, BAR_TOP_RECORDING), (320, 716, 800, 100));
    }
}
