//! The running recording: one `Session` in app state, the recorder hotkeys, and stop into the editor.
//!
//! Hotkeys are registered while the recorder is open: during setup by a setup input thread (its
//! clock is never set, so it logs nothing), during the recording by the session's own input thread.
//! Both send `Hotkey`s on one channel to the `marz-hotkeys` thread, which calls the same functions
//! as the bar's buttons, so the keys work while another app has focus. Rust emits
//! `recorder://state` after every change and every 250 ms while recording. The bar and the overlay
//! switch to the recording look only on a state with `recording: true`, which is first emitted
//! after `Session::start` returned, that is after `SessionEvent::Recording` (the warm-up rule).

use crate::recorder::Rect;
use marz_capture::project::{NormRect, ZoomPreset};
use serde::{Deserialize, Serialize};

pub const STATE_EVENT: &str = "recorder://state";
pub const WARNING_EVENT: &str = "recorder://warning";
pub const FAILED_EVENT: &str = "recorder://failed";
/// Sent to the main window with the project folder after a stop.
pub const OPEN_EVENT: &str = "recorder://open-project";

pub const NOT_RECORDING: &str = "Nothing is recording.";
pub const PRESET_INVALID: &str = "A zoom preset is not valid. Draw it again.";

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct PresetDto {
    pub id: String,
    pub name: String,
    pub rect: NormRect,
}

/// What the bar sends on Record (built from the setup by `recordOptions` in the page).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptionsDto {
    /// "full", "region" or "exact".
    pub mode: String,
    /// Physical pixels relative to the monitor (ignored in Full screen).
    pub region: Rect,
    /// None records without a mic.
    pub mic_id: Option<String>,
    pub cursor_hidden: bool,
    /// Ids "p1" to "p9", rects normalized to the region (the monitor in Full screen).
    pub presets: Vec<PresetDto>,
}

/// The checked options.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub region: Option<Rect>,
    pub mic_id: Option<String>,
    pub cursor_hidden: bool,
    pub presets: Vec<ZoomPreset>,
}

/// The session preset id for hotkey Ctrl+n.
pub fn preset_id(n: u8) -> String {
    format!("p{n}")
}

fn valid_rect(r: &NormRect) -> bool {
    const E: f64 = 1e-9;
    [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite())
        && r.x >= -E
        && r.y >= -E
        && r.w > 0.0
        && r.h > 0.0
        && r.x + r.w <= 1.0 + E
        && r.y + r.h <= 1.0 + E
}

/// Check the page's options: a known mode, presets "p1" to "p9" once each with a rect inside the
/// source. Presets come back in id order; an empty name becomes "Zoom n".
pub fn plan(dto: RecordOptionsDto) -> Result<Plan, String> {
    let region = match dto.mode.as_str() {
        "full" => None,
        "region" | "exact" => Some(dto.region),
        _ => return Err("Pick a capture mode.".into()),
    };
    let mut presets: Vec<ZoomPreset> = Vec::new();
    for p in dto.presets {
        let n = p.id.strip_prefix('p').filter(|n| n.len() == 1).and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=9).contains(n));
        let Some(n) = n else { return Err(PRESET_INVALID.into()) };
        if !valid_rect(&p.rect) || presets.iter().any(|q| q.id == p.id) {
            return Err(PRESET_INVALID.into());
        }
        let name = p.name.trim();
        let name = if name.is_empty() { format!("Zoom {n}") } else { name.to_string() };
        presets.push(ZoomPreset { id: p.id, name, rect: p.rect });
    }
    presets.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Plan { region, mic_id: dto.mic_id, cursor_hidden: dto.cursor_hidden, presets })
}

/// `<stamp> Recording`, then `<stamp> Recording 2`, `3`, ... while `taken` says the name is used.
/// `stamp` is the local time as `YYYY-MM-DD HH.mm`.
pub fn recording_name(stamp: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = format!("{stamp} Recording");
    if !taken(&base) {
        return base;
    }
    (2u32..).map(|n| format!("{base} {n}")).find(|n| !taken(n)).unwrap_or(base)
}

/// The active preset after a zoom request. Mirrors `Session::zoom`: ignored while paused, unknown
/// presets ignored, zoom out clears.
pub fn next_active(active: Option<&str>, request: Option<&str>, paused: bool, presets: &[String]) -> Option<String> {
    if paused {
        return active.map(str::to_string);
    }
    match request {
        Some(id) if presets.iter().any(|p| p == id) => Some(id.to_string()),
        Some(_) => active.map(str::to_string),
        None => None,
    }
}

/// What the bar and the overlay show while recording.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecState {
    pub recording: bool,
    pub paused: bool,
    pub muted: bool,
    /// The recording has a mic track (Mute works).
    pub mic: bool,
    /// Session preset id ("p1") of the live zoom, if any.
    pub active_preset: Option<String>,
    /// Recording time, pauses excluded.
    pub rec_us: i64,
}

pub use imp::{arm_setup_keys, shutdown, Recording};

/// Start recording with the bar's setup. Returns once the engine reports Recording.
#[tauri::command(async)]
pub fn start_recording(app: tauri::AppHandle, opts: RecordOptionsDto) -> Result<(), String> {
    imp::start(&app, plan(opts)?)
}

#[tauri::command]
pub fn pause_recording(app: tauri::AppHandle) -> Result<(), String> {
    imp::pause(&app, Some(true))
}

#[tauri::command]
pub fn resume_recording(app: tauri::AppHandle) -> Result<(), String> {
    imp::pause(&app, Some(false))
}

#[tauri::command]
pub fn set_mic_muted(app: tauri::AppHandle, muted: bool) -> Result<(), String> {
    imp::mute(&app, Some(muted))
}

/// `Some("p1")` zooms into that preset, None zooms out.
#[tauri::command]
pub fn trigger_zoom(app: tauri::AppHandle, preset_id: Option<String>) -> Result<(), String> {
    imp::zoom(&app, preset_id)
}

/// Stop, close the recorder, show the main window and open the project there. Returns the folder.
#[tauri::command(async)]
pub fn stop_recording(app: tauri::AppHandle) -> Result<String, String> {
    if !imp::is_live(&app) {
        return Err(NOT_RECORDING.into());
    }
    crate::recorder::close_all(&app).unwrap_or_else(|| Err(NOT_RECORDING.into()))
}

#[tauri::command]
pub fn recording_state(app: tauri::AppHandle) -> RecState {
    imp::snapshot(&app)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::recorder::{BAR, OVERLAY};
    use marz_capture::region::PxRect;
    use marz_capture::win::input::{self, Hotkey, InputHandle, InputShared};
    use marz_capture::win::new_clock;
    use marz_capture::win::session::{RecordOptions, Session, SessionEvent};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
    use std::thread;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};

    const FPS: u32 = 60;
    const TICK: Duration = Duration::from_millis(250);

    struct Live {
        session: Session,
        presets: Vec<String>,
        active: Option<String>,
        mic: bool,
    }

    /// Lock order: `live` alone, or `keys` alone; never both. Nothing that emits or touches a
    /// window runs under `live` except `emit_state` (emit does not wait for the page).
    #[derive(Default)]
    pub struct Recording {
        live: Mutex<Option<Live>>,
        /// The setup hotkeys (an input thread without a clock) while the recorder is open and not recording.
        keys: Mutex<Option<InputHandle>>,
        hotkeys: OnceLock<mpsc::Sender<Hotkey>>,
        /// A start is running.
        starting: AtomicBool,
        /// Bumped on every start and stop, so an old 250 ms ticker ends.
        generation: AtomicU64,
    }

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn state(app: &AppHandle) -> tauri::State<'_, Recording> {
        app.state::<Recording>()
    }

    pub fn is_live(app: &AppHandle) -> bool {
        lock(&state(app).live).is_some()
    }

    pub fn snapshot(app: &AppHandle) -> RecState {
        let st = state(app);
        let g = lock(&st.live);
        let Some(l) = g.as_ref() else { return RecState::default() };
        let p = l.session.progress();
        RecState {
            recording: true,
            paused: p.paused,
            muted: l.session.is_mic_muted(),
            mic: l.mic,
            active_preset: l.active.clone(),
            rec_us: p.rec_us,
        }
    }

    /// Send the state to both recorder windows. False when nothing is recording.
    fn emit_state(app: &AppHandle) -> bool {
        let s = snapshot(app);
        for w in [BAR, OVERLAY] {
            let _ = app.emit_to(w, STATE_EVENT, &s);
        }
        s.recording
    }

    /// The channel every hotkey goes to; the first call starts the `marz-hotkeys` thread.
    fn hotkey_sender(app: &AppHandle) -> mpsc::Sender<Hotkey> {
        state(app)
            .hotkeys
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<Hotkey>();
                let app = app.clone();
                // If the thread cannot start, the hotkeys do nothing; the buttons still work.
                let _ = thread::Builder::new().name("marz-hotkeys".into()).spawn(move || {
                    for h in rx {
                        on_hotkey(&app, h);
                    }
                });
                tx
            })
            .clone()
    }

    fn on_hotkey(app: &AppHandle, h: Hotkey) {
        match h {
            Hotkey::RecordStop => {
                if is_live(app) {
                    let _ = crate::recorder::close_all(app);
                } else if !state(app).starting.load(Ordering::SeqCst) {
                    // The setup lives in the bar: it starts the recording with it.
                    let _ = app.emit_to(BAR, "recorder://record", ());
                }
            }
            Hotkey::Pause => {
                let _ = pause(app, None);
            }
            Hotkey::Mute => {
                let _ = mute(app, None);
            }
            Hotkey::Preset(n) => {
                let _ = zoom(app, Some(preset_id(n)));
            }
            Hotkey::ZoomOut => {
                let _ = zoom(app, None);
            }
        }
    }

    /// Register the hotkeys for the setup. Warnings ("Hotkey Ctrl+1 is taken by another app") go to the bar.
    pub fn arm_setup_keys(app: &AppHandle) {
        let st = state(app);
        let mut keys = lock(&st.keys);
        if keys.is_some() {
            return;
        }
        let (warn_tx, warn_rx) = mpsc::channel::<String>();
        let shared = InputShared::new(new_clock(), hotkey_sender(app), warn_tx);
        if let Ok(h) = input::start(shared, true) {
            *keys = Some(h);
        }
        let app = app.clone();
        // Ends when the input thread is stopped (its warning sender is dropped then).
        let _ = thread::Builder::new().name("marz-setup-warn".into()).spawn(move || {
            for w in warn_rx {
                let _ = app.emit_to(BAR, WARNING_EVENT, w);
            }
        });
    }

    fn disarm_setup_keys(app: &AppHandle) {
        let h = lock(&state(app).keys).take();
        if let Some(h) = h {
            let _ = h.stop(); // joins: the keys are free for the session afterwards
        }
    }

    fn local_stamp() -> String {
        let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        format!("{:04}-{:02}-{:02} {:02}.{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute)
    }

    fn set_click_through(app: &AppHandle, on: bool) {
        if let Some(w) = app.get_webview_window(OVERLAY) {
            let _ = w.set_ignore_cursor_events(on);
        }
    }

    struct Starting<'a>(&'a AtomicBool);
    impl Drop for Starting<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    pub fn start(app: &AppHandle, plan: Plan) -> Result<(), String> {
        let st = state(app);
        if st.starting.swap(true, Ordering::SeqCst) {
            return Err("The recording is starting.".into());
        }
        let _starting = Starting(&st.starting);
        if is_live(app) {
            return Err("A recording is already running.".into());
        }
        let mon = crate::recorder::current_monitor(app)?;
        crate::recorder::stop_meter(app); // the session opens the same mic
        let out_dir = crate::projects::default_dir(app)?;
        let name = recording_name(&local_stamp(), |n| out_dir.join(format!("{n}.marz")).exists());
        let presets: Vec<String> = plan.presets.iter().map(|p| p.id.clone()).collect();
        let mic = plan.mic_id.is_some();
        let opts = RecordOptions {
            out_dir,
            name,
            monitor: mon.index,
            region: plan.region.map(|r| PxRect { x: r.x, y: r.y, w: r.w, h: r.h }),
            fps: FPS,
            mic_id: plan.mic_id,
            cursor_hidden: plan.cursor_hidden,
            presets: plan.presets,
            encoder: None,
        };

        disarm_setup_keys(app); // the session registers the same keys
        let tx = hotkey_sender(app);
        let ev_app = app.clone();
        let on_event = Box::new(move |e: SessionEvent| match e {
            // The state with `recording: true` is emitted once `start` returned, right after this.
            SessionEvent::Recording => {}
            SessionEvent::MicLevel(l) => {
                let _ = ev_app.emit_to(BAR, "recorder://level", l);
            }
            SessionEvent::Warning(w) => {
                let _ = ev_app.emit_to(BAR, WARNING_EVENT, w);
            }
            SessionEvent::Hotkey(h) => {
                let _ = tx.send(h);
            }
            SessionEvent::Failed(m) => {
                // Not on the session's own thread: stopping the session joins it.
                let app = ev_app.clone();
                let _ = thread::Builder::new().name("marz-failed".into()).spawn(move || failed(&app, m));
            }
        });

        let session = match Session::start(opts, on_event) {
            Ok(s) => s,
            Err(e) => {
                arm_setup_keys(app);
                return Err(e.to_string());
            }
        };
        let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&st.live) = Some(Live { session, presets, active: None, mic });
        if crate::recorder::current_monitor(app).is_err() {
            // The recorder was closed while starting: keep what was recorded and open it.
            let _ = crate::recorder::close_all(app);
            return Ok(());
        }
        set_click_through(app, true);
        emit_state(app);
        let app = app.clone();
        let _ = thread::Builder::new().name("marz-rec-tick".into()).spawn(move || {
            loop {
                thread::sleep(TICK);
                if state(&app).generation.load(Ordering::SeqCst) != generation || !emit_state(&app) {
                    break;
                }
            }
        });
        Ok(())
    }

    /// The engine cannot continue: stop what is there (the crash marker keeps it recoverable when
    /// the files are broken), and return the bar to the setup with the sentence.
    fn failed(app: &AppHandle, msg: String) {
        let st = state(app);
        let live = lock(&st.live).take();
        let Some(live) = live else { return }; // a failed start: `start` returns the error itself
        st.generation.fetch_add(1, Ordering::SeqCst);
        let _ = live.session.stop();
        set_click_through(app, false);
        if crate::recorder::current_monitor(app).is_ok() {
            arm_setup_keys(app);
        }
        emit_state(app);
        let _ = app.emit_to(BAR, FAILED_EVENT, msg);
    }

    fn with_live<R>(app: &AppHandle, f: impl FnOnce(&mut Live) -> R) -> Result<R, String> {
        let r = {
            let st = state(app);
            let mut g = lock(&st.live);
            let l = g.as_mut().ok_or(NOT_RECORDING)?;
            f(l)
        };
        emit_state(app);
        Ok(r)
    }

    /// `Some(true)` pauses, `Some(false)` resumes, None toggles.
    pub fn pause(app: &AppHandle, to: Option<bool>) -> Result<(), String> {
        with_live(app, |l| {
            let pause = to.unwrap_or(!l.session.is_paused());
            if pause { l.session.pause() } else { l.session.resume() }
        })
    }

    /// `Some(m)` sets, None toggles.
    pub fn mute(app: &AppHandle, to: Option<bool>) -> Result<(), String> {
        with_live(app, |l| {
            let m = to.unwrap_or(!l.session.is_mic_muted());
            l.session.set_mic_muted(m);
        })
    }

    pub fn zoom(app: &AppHandle, id: Option<String>) -> Result<(), String> {
        with_live(app, |l| {
            if id.is_some() && id == l.active {
                return; // the same preset again would split its live zoom block in two
            }
            let next = next_active(l.active.as_deref(), id.as_deref(), l.session.is_paused(), &l.presets);
            let known = id.as_ref().is_none_or(|i| l.presets.contains(i));
            if known && !l.session.is_paused() {
                l.session.zoom(id.as_deref());
            }
            l.active = next;
        })
    }

    /// On closing the recorder: free the setup hotkeys, and stop a running recording. Returns the
    /// project folder (allowed for the editor) when a recording was stopped.
    pub fn shutdown(app: &AppHandle) -> Option<Result<String, String>> {
        disarm_setup_keys(app);
        let st = state(app);
        let live = lock(&st.live).take()?;
        st.generation.fetch_add(1, Ordering::SeqCst);
        let res = live.session.stop().map_err(|e| e.to_string()).and_then(|r| {
            crate::projects::allow_recording(app, &r.dir)?;
            Ok(r.dir.to_string_lossy().into_owned())
        });
        Some(res)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use tauri::AppHandle;

    const NEEDS_WINDOWS: &str = "Recording needs Windows.";

    #[derive(Default)]
    pub struct Recording;

    pub fn is_live(_app: &AppHandle) -> bool {
        false
    }
    pub fn snapshot(_app: &AppHandle) -> RecState {
        RecState::default()
    }
    pub fn arm_setup_keys(_app: &AppHandle) {}
    pub fn start(_app: &AppHandle, _plan: Plan) -> Result<(), String> {
        Err(NEEDS_WINDOWS.into())
    }
    pub fn pause(_app: &AppHandle, _to: Option<bool>) -> Result<(), String> {
        Err(NOT_RECORDING.into())
    }
    pub fn mute(_app: &AppHandle, _to: Option<bool>) -> Result<(), String> {
        Err(NOT_RECORDING.into())
    }
    pub fn zoom(_app: &AppHandle, _id: Option<String>) -> Result<(), String> {
        Err(NOT_RECORDING.into())
    }
    pub fn shutdown(_app: &AppHandle) -> Option<Result<String, String>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dto(mode: &str, presets: Vec<PresetDto>) -> RecordOptionsDto {
        RecordOptionsDto {
            mode: mode.into(),
            region: Rect { x: 10, y: 20, w: 1280, h: 720 },
            mic_id: Some("mic".into()),
            cursor_hidden: true,
            presets,
        }
    }

    fn p(id: &str, name: &str, x: f64) -> PresetDto {
        PresetDto { id: id.into(), name: name.into(), rect: NormRect { x, y: 0.1, w: 0.3, h: 0.3 } }
    }

    #[test]
    fn plan_keeps_the_region_except_in_full_screen_and_sorts_presets() {
        let pl = plan(dto("region", vec![p("p2", "Terminal output", 0.5), p("p1", " ", 0.1)])).unwrap();
        assert_eq!(pl.region, Some(Rect { x: 10, y: 20, w: 1280, h: 720 }));
        assert_eq!(pl.presets.iter().map(|z| (z.id.as_str(), z.name.as_str())).collect::<Vec<_>>(), [("p1", "Zoom 1"), ("p2", "Terminal output")]);
        assert_eq!(pl.mic_id.as_deref(), Some("mic"));
        assert!(pl.cursor_hidden);
        assert_eq!(plan(dto("full", vec![])).unwrap().region, None);
        assert!(plan(dto("window", vec![])).is_err());
    }

    #[test]
    fn plan_refuses_bad_presets() {
        for bad in [p("1", "a", 0.1), p("p0", "a", 0.1), p("p10", "a", 0.1), p("p3", "a", 0.8), p("p3", "a", f64::NAN)] {
            assert_eq!(plan(dto("region", vec![bad])), Err(PRESET_INVALID.to_string()));
        }
        assert!(plan(dto("region", vec![p("p1", "a", 0.1), p("p1", "b", 0.2)])).is_err());
    }

    #[test]
    fn recording_names_count_up_when_taken() {
        assert_eq!(recording_name("2026-11-17 16.31", |_| false), "2026-11-17 16.31 Recording");
        let taken = ["2026-11-17 16.31 Recording", "2026-11-17 16.31 Recording 2"];
        assert_eq!(recording_name("2026-11-17 16.31", |n| taken.contains(&n)), "2026-11-17 16.31 Recording 3");
    }

    #[test]
    fn hotkey_n_maps_to_preset_pn() {
        assert_eq!(preset_id(1), "p1");
        assert_eq!(preset_id(9), "p9");
    }

    #[test]
    fn active_preset_follows_the_session_rules() {
        let ids = vec!["p1".to_string(), "p2".to_string()];
        assert_eq!(next_active(None, Some("p1"), false, &ids), Some("p1".into()));
        assert_eq!(next_active(Some("p1"), Some("p2"), false, &ids), Some("p2".into()));
        assert_eq!(next_active(Some("p1"), Some("p5"), false, &ids), Some("p1".into()), "unknown preset ignored");
        assert_eq!(next_active(Some("p1"), None, false, &ids), None);
        assert_eq!(next_active(Some("p1"), None, true, &ids), Some("p1".into()), "ignored while paused");
        assert_eq!(next_active(None, Some("p2"), true, &ids), None);
    }
}
