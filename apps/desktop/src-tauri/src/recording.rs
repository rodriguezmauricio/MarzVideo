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
    /// Also record the computer's sound (`system.wav`). Missing from older pages: off.
    #[serde(default)]
    pub system_audio: bool,
    /// Media Foundation camera id; None (and older pages) record without a camera.
    #[serde(default)]
    pub camera_id: Option<String>,
    pub cursor_hidden: bool,
    /// Ids "p1" to "p9", rects normalized to the region (the monitor in Full screen).
    pub presets: Vec<PresetDto>,
}

/// The checked options.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub region: Option<Rect>,
    pub mic_id: Option<String>,
    pub system_audio: bool,
    pub camera_id: Option<String>,
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
    Ok(Plan { region, mic_id: dto.mic_id, system_audio: dto.system_audio, camera_id: dto.camera_id, cursor_hidden: dto.cursor_hidden, presets })
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

/// Sent to the main window when a stop could not finish the files (the recover banner has it).
pub const STOP_FAILED_EVENT: &str = "recorder://stop-failed";
pub const STOP_FAILED: &str = "Recording could not be finished. Recover it below.";

/// What closing the recorder did with the recording.
#[derive(Debug, Clone, PartialEq)]
pub enum Shutdown {
    /// Nothing was recording.
    Nothing,
    /// Another stop (or a failure) is finishing the recording; it shows the main window when done.
    Busy,
    /// The recording was stopped: its folder, or why the files could not be finished.
    Stopped(Result<String, String>),
}

/// What the start, stop and failure paths share, all under one lock, so they cannot race: the
/// running recording, the attempt being started, a stop in progress, and a failure that came in
/// before its session was stored.
#[derive(Debug)]
pub struct Slot<T> {
    live: Option<T>,
    live_attempt: u64,
    starting: Option<u64>,
    stopping: bool,
    pending_fail: Option<(u64, String)>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Slot { live: None, live_attempt: 0, starting: None, stopping: false, pending_fail: None }
    }
}

/// What to do with an engine failure.
#[derive(Debug, PartialEq)]
pub enum FailRoute<T> {
    /// It belongs to the running recording: the caller stops it (the slot is now stopping).
    Handle(T),
    /// Its session is still being stored: `attach` hands it back.
    Deferred,
    /// Old, already stopping, or a failed start (that returns its own error).
    Ignored,
}

/// What a stop finds.
#[derive(Debug, PartialEq)]
pub enum Take<T> {
    Nothing,
    Busy,
    Took(T),
}

impl<T> Slot<T> {
    pub fn live(&self) -> Option<&T> {
        self.live.as_ref()
    }

    pub fn live_mut(&mut self) -> Option<&mut T> {
        self.live.as_mut()
    }

    pub fn is_starting(&self) -> bool {
        self.starting.is_some()
    }

    /// A start may begin: nothing running, starting or stopping.
    pub fn begin_start(&mut self, attempt: u64) -> Result<(), String> {
        if self.starting.is_some() {
            return Err("The recording is starting.".into());
        }
        if self.live.is_some() || self.stopping {
            return Err("A recording is already running.".into());
        }
        self.starting = Some(attempt);
        self.pending_fail = None;
        Ok(())
    }

    /// The engine refused to start.
    pub fn start_failed(&mut self) {
        self.starting = None;
        self.pending_fail = None;
    }

    /// Store the started session. If its failure already came in, the session comes back with
    /// the sentence (and the slot is stopping), so the caller stops it at once.
    pub fn attach(&mut self, attempt: u64, live: T) -> Option<(T, String)> {
        self.starting = None;
        match self.pending_fail.take() {
            Some((a, msg)) if a == attempt => {
                self.stopping = true;
                Some((live, msg))
            }
            _ => {
                self.live = Some(live);
                self.live_attempt = attempt;
                None
            }
        }
    }

    pub fn fail(&mut self, attempt: u64, msg: String) -> FailRoute<T> {
        if !self.stopping && self.live_attempt == attempt && let Some(l) = self.live.take() {
            self.stopping = true;
            return FailRoute::Handle(l);
        }
        if self.starting == Some(attempt) {
            self.pending_fail = Some((attempt, msg));
            return FailRoute::Deferred;
        }
        FailRoute::Ignored
    }

    /// Take the recording to stop it; a second stop while one runs gets `Busy`.
    pub fn take_for_stop(&mut self) -> Take<T> {
        if self.stopping {
            return Take::Busy;
        }
        match self.live.take() {
            Some(l) => {
                self.stopping = true;
                Take::Took(l)
            }
            None => Take::Nothing,
        }
    }

    pub fn stop_done(&mut self) {
        self.stopping = false;
    }
}

pub use imp::{arm_setup_keys, set_open, shutdown, Recording};

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

/// Move or resize a zoom preset while recording (`preset_id` "p1"..; rect normalized to the
/// source). The zoom running on it now and later zooms to it take the new frame.
#[tauri::command]
pub fn set_preset_rect(app: tauri::AppHandle, preset_id: String, rect: NormRect) -> Result<(), String> {
    if !valid_rect(&rect) {
        return Err(PRESET_INVALID.into());
    }
    imp::set_preset_rect(&app, &preset_id, rect)
}

/// Stop, close the recorder, show the main window and open the project there. Returns the folder.
#[tauri::command(async)]
pub fn stop_recording(app: tauri::AppHandle) -> Result<String, String> {
    if !imp::is_live(&app) {
        return Err(NOT_RECORDING.into());
    }
    match crate::recorder::close_all(&app) {
        Shutdown::Stopped(r) => r,
        Shutdown::Busy => Err("The recording is already stopping.".into()),
        Shutdown::Nothing => Err(NOT_RECORDING.into()),
    }
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

    /// Lock order: `slot` alone, or `keys` alone; never both. Nothing that emits or touches a
    /// window runs under `slot`, and `Session::start` and `stop` run outside it.
    #[derive(Default)]
    pub struct Recording {
        slot: Mutex<Slot<Live>>,
        /// The setup hotkeys (an input thread without a clock) while the recorder is open and not recording.
        keys: Mutex<Option<InputHandle>>,
        hotkeys: OnceLock<mpsc::Sender<Hotkey>>,
        /// The recorder windows are open. `close_all` clears it before it frees the keys, so a
        /// start that fails after a close never registers them again.
        open: AtomicBool,
        attempts: AtomicU64,
        /// Bumped on every start and stop, so an old 250 ms ticker ends.
        generation: AtomicU64,
    }

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn state(app: &AppHandle) -> tauri::State<'_, Recording> {
        app.state::<Recording>()
    }

    pub fn set_open(app: &AppHandle, open: bool) {
        state(app).open.store(open, Ordering::SeqCst);
    }

    fn is_open(app: &AppHandle) -> bool {
        state(app).open.load(Ordering::SeqCst)
    }

    pub fn is_live(app: &AppHandle) -> bool {
        lock(&state(app).slot).live().is_some()
    }

    pub fn snapshot(app: &AppHandle) -> RecState {
        let st = state(app);
        let g = lock(&st.slot);
        let Some(l) = g.live() else { return RecState::default() };
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
                let (live, starting) = {
                    let st = state(app);
                    let g = lock(&st.slot);
                    (g.live().is_some(), g.is_starting())
                };
                if live {
                    let _ = crate::recorder::close_all(app);
                } else if !starting && is_open(app) {
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

    /// Register the hotkeys for the setup, only while the recorder is open. Warnings ("Hotkey
    /// Ctrl+1 is taken by another app") go to the bar. `close_all` clears `open` before it takes
    /// the keys lock, so either this sees the close and does nothing, or the close frees what this
    /// registered; the re-check after starting is a second guard.
    pub fn arm_setup_keys(app: &AppHandle) {
        let st = state(app);
        let mut keys = lock(&st.keys);
        if keys.is_some() || !is_open(app) {
            return;
        }
        let (warn_tx, warn_rx) = mpsc::channel::<String>();
        let shared = InputShared::new(new_clock(), hotkey_sender(app), warn_tx);
        let Ok(h) = input::start(shared, true) else { return };
        if !is_open(app) {
            let _ = h.stop();
            return;
        }
        *keys = Some(h);
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

    pub fn start(app: &AppHandle, plan: Plan) -> Result<(), String> {
        let st = state(app);
        let attempt = st.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        lock(&st.slot).begin_start(attempt)?;
        let (session, presets, mic) = match open_session(app, attempt, plan) {
            Ok(s) => s,
            Err(e) => {
                lock(&st.slot).start_failed();
                arm_setup_keys(app); // only if the recorder is still open
                return Err(e);
            }
        };
        let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let early = lock(&st.slot).attach(attempt, Live { session, presets, active: None, mic });
        if let Some((live, msg)) = early {
            // The engine failed between its start and here: handle it as any failure.
            after_failure(app, live, msg);
            return Ok(());
        }
        if !is_open(app) {
            // The recorder was closed while starting: keep what was recorded and open it.
            let _ = crate::recorder::close_all(app);
            return Ok(());
        }
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

    /// Build the options and start the engine: the session, its preset ids and the mic flag.
    fn open_session(app: &AppHandle, attempt: u64, plan: Plan) -> Result<(Session, Vec<String>, bool), String> {
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
            system_audio: plan.system_audio,
            camera_id: plan.camera_id,
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
                let _ = thread::Builder::new().name("marz-failed".into()).spawn(move || failed(&app, attempt, m));
            }
        });
        let session = Session::start(opts, on_event).map_err(|e| e.to_string())?;
        Ok((session, presets, mic))
    }

    /// The engine cannot continue. A failure of the running recording stops it; one that came in
    /// before its session was stored is handed back by `attach`; others are ignored.
    fn failed(app: &AppHandle, attempt: u64, msg: String) {
        let route = lock(&state(app).slot).fail(attempt, msg.clone());
        if let FailRoute::Handle(live) = route {
            after_failure(app, live, msg);
        }
    }

    /// Stop a failed recording (the crash marker keeps it recoverable when the files are broken).
    /// With the recorder open the bar returns to the setup with the sentence; if it was closed
    /// meanwhile (that close found the stop busy) the main window comes back here.
    fn after_failure(app: &AppHandle, live: Live, msg: String) {
        let st = state(app);
        st.generation.fetch_add(1, Ordering::SeqCst);
        let res = finish(app, live);
        lock(&st.slot).stop_done();
        if is_open(app) {
            arm_setup_keys(app);
            emit_state(app);
            let _ = app.emit_to(BAR, FAILED_EVENT, msg);
        } else {
            crate::recorder::land(app, &Shutdown::Stopped(res));
        }
    }

    /// Stop the session and allow its folder for the editor.
    fn finish(app: &AppHandle, live: Live) -> Result<String, String> {
        live.session.stop().map_err(|e| e.to_string()).and_then(|r| {
            crate::projects::allow_recording(app, &r.dir)?;
            Ok(r.dir.to_string_lossy().into_owned())
        })
    }

    fn with_live<R>(app: &AppHandle, f: impl FnOnce(&mut Live) -> R) -> Result<R, String> {
        let r = {
            let st = state(app);
            let mut g = lock(&st.slot);
            let l = g.live_mut().ok_or(NOT_RECORDING)?;
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

    pub fn set_preset_rect(app: &AppHandle, id: &str, rect: NormRect) -> Result<(), String> {
        with_live(app, |l| l.session.set_preset_rect(id, rect))
    }

    /// On closing the recorder (`open` already cleared): free the setup hotkeys and stop a running
    /// recording. A second close while a stop runs gets `Busy`.
    pub fn shutdown(app: &AppHandle) -> Shutdown {
        disarm_setup_keys(app);
        let st = state(app);
        let took = lock(&st.slot).take_for_stop();
        let live = match took {
            Take::Nothing => return Shutdown::Nothing,
            Take::Busy => return Shutdown::Busy,
            Take::Took(l) => l,
        };
        st.generation.fetch_add(1, Ordering::SeqCst);
        let res = finish(app, live);
        lock(&st.slot).stop_done();
        Shutdown::Stopped(res)
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
    pub fn set_open(_app: &AppHandle, _open: bool) {}
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
    pub fn set_preset_rect(_app: &AppHandle, _id: &str, _rect: NormRect) -> Result<(), String> {
        Err(NOT_RECORDING.into())
    }
    pub fn shutdown(_app: &AppHandle) -> Shutdown {
        Shutdown::Nothing
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
            system_audio: false,
            camera_id: None,
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
        assert_eq!(pl.camera_id, None);
        let mut with_cam = dto("full", vec![]);
        with_cam.camera_id = Some("cam".into());
        assert_eq!(plan(with_cam).unwrap().camera_id.as_deref(), Some("cam"));
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

    #[test]
    fn a_second_stop_while_one_runs_is_busy_and_a_stop_after_it_finds_nothing() {
        let mut s: Slot<&str> = Slot::default();
        s.begin_start(1).unwrap();
        assert_eq!(s.attach(1, "rec"), None);
        assert_eq!(s.take_for_stop(), Take::Took("rec"));
        assert_eq!(s.take_for_stop(), Take::Busy, "button plus Ctrl+Shift+R");
        assert!(s.begin_start(2).is_err(), "no new start while the files are being finished");
        s.stop_done();
        assert_eq!(s.take_for_stop(), Take::Nothing);
        assert!(s.begin_start(2).is_ok());
    }

    #[test]
    fn a_failure_before_the_session_is_stored_comes_back_from_attach() {
        let mut s: Slot<&str> = Slot::default();
        s.begin_start(7).unwrap();
        assert_eq!(s.fail(7, "The video encoder stopped.".into()), FailRoute::Deferred);
        assert_eq!(s.attach(7, "rec"), Some(("rec", "The video encoder stopped.".to_string())));
        assert!(s.live().is_none());
        assert_eq!(s.take_for_stop(), Take::Busy, "the failure path is stopping it");
        s.stop_done();
        assert_eq!(s.take_for_stop(), Take::Nothing);
    }

    #[test]
    fn a_failure_of_the_running_recording_is_handled_once() {
        let mut s: Slot<&str> = Slot::default();
        s.begin_start(1).unwrap();
        s.attach(1, "rec");
        assert_eq!(s.fail(1, "x".into()), FailRoute::Handle("rec"));
        assert_eq!(s.fail(1, "x".into()), FailRoute::Ignored);
        assert_eq!(s.take_for_stop(), Take::Busy, "a close during the failure stop leaves Home to it");
    }

    #[test]
    fn failures_of_other_attempts_or_during_a_stop_are_ignored() {
        let mut s: Slot<&str> = Slot::default();
        s.begin_start(1).unwrap();
        s.attach(1, "rec");
        assert_eq!(s.fail(2, "old".into()), FailRoute::Ignored);
        assert_eq!(s.take_for_stop(), Take::Took("rec"));
        assert_eq!(s.fail(1, "during stop".into()), FailRoute::Ignored);
        s.stop_done();
        // a failed start leaves nothing pending for the next one
        s.begin_start(3).unwrap();
        assert_eq!(s.fail(3, "mic".into()), FailRoute::Deferred);
        s.start_failed();
        s.begin_start(4).unwrap();
        assert_eq!(s.attach(4, "next"), None);
        assert_eq!(s.live(), Some(&"next"));
    }

    #[test]
    fn only_one_start_at_a_time() {
        let mut s: Slot<&str> = Slot::default();
        s.begin_start(1).unwrap();
        assert_eq!(s.begin_start(2), Err("The recording is starting.".to_string()));
        assert!(s.is_starting());
        s.attach(1, "rec");
        assert_eq!(s.begin_start(2), Err("A recording is already running.".to_string()));
    }
}
