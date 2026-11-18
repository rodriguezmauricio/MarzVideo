//! One recording: wires screen, mic, input, the CFR writer and FFmpeg into a `.marz` folder.
//!
//! Start order (the spike's): folder and crash marker, FFmpeg lookup and encoder probe, encoder
//! process, input thread, mic, screen and writer, wait until screen and mic deliver (max 3 s), t0,
//! events header, `Recording`. Stop order: stop time and the writer's end index, WGC, writer, mic
//! (pad or cut to the duration), input, FFmpeg, `project.json` with live zooms, marker removed.
//!
//! Every module started before an error is stopped again (the handles have no `Drop`), so no
//! thread, hook or hotkey outlives a failed start.

use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::input::{self, Hotkey, InputHandle, InputShared};
use super::mic::{self, MicHandle, MicReport, MicShared};
use super::monitors::list_monitors;
use super::qpc::{new_guid, qpc_hns};
use super::screen::{self, ScreenHandle, ScreenShared};
use super::{new_clock, set_dpi_awareness, SharedClock};
use crate::clock::RecClock;
use crate::events::{EventLog, EventsHeader, ZoomAction};
use crate::ffmpeg::{self, ScreenEncoder};
use crate::project::{self, LiveZoomMark, MicMeta, NormRect, ProjectMeta, ZoomPreset, CRASH_MARKER};
use crate::region::{capture_fps, normalize_region, PxRect};
use crate::slots::Slotter;
use crate::writer::{self, SlotFrame, WriterStats};
use crate::CaptureError;

pub const MIC_DID_NOT_START: &str = "The microphone did not start. Pick another one or record without it.";
pub const SCREEN_DID_NOT_START: &str = "The screen capture did not start. Try again.";
pub const SCREEN_NOT_FOUND: &str = "This screen was not found. Pick another one.";
pub const NAME_TAKEN: &str = "A recording with this name already exists. Pick another name.";
pub const ENCODER_STOPPED: &str = "The video encoder stopped. Stop the recording to keep what was saved.";
pub const SYSTEM_DID_NOT_START: &str = "Computer sound could not be recorded. Recording continues without it.";
pub const MIC_SILENT: &str = "The microphone sent no sound. The mic track is silent.";

/// How long screen and mic get to deliver their first data before t0.
const WARM_TIMEOUT: Duration = Duration::from_secs(3);
/// Forwarder period: warnings, hotkeys, the mic level and the marker rewrite.
const TICK: Duration = Duration::from_millis(50);

/// What to record.
#[derive(Debug, Clone)]
pub struct RecordOptions {
    /// Folder that receives the project; the project folder is `out_dir/<name>.marz`.
    pub out_dir: PathBuf,
    /// Project name (`project.json` `name`) and folder stem.
    pub name: String,
    /// Monitor index from `list_monitors`.
    pub monitor: usize,
    /// Monitor-relative region; None records the whole monitor.
    pub region: Option<PxRect>,
    pub fps: u32,
    /// WASAPI endpoint id; None records without a mic (no `mic.wav`, no mic track).
    pub mic_id: Option<String>,
    /// Also record the computer's sound (loopback on the default output device) into `system.wav`.
    pub system_audio: bool,
    pub cursor_hidden: bool,
    pub presets: Vec<ZoomPreset>,
    /// FFmpeg encoder name; None probes (nvenc, amf, qsv, then libx264).
    pub encoder: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// t0 was taken: both tracks deliver.
    Recording,
    /// Mic peak level 0..1, every 50 ms (0 while muted or without a mic).
    MicLevel(f32),
    /// A user-facing sentence; the recording continues.
    Warning(String),
    /// A recorder hotkey was pressed; the caller decides what it does.
    Hotkey(Hotkey),
    /// The recording cannot continue (start failed, or the encoder died).
    Failed(String),
}

type OnEvent = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// Live counters for a progress line or a timer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    /// Recording time now (pauses excluded).
    pub rec_us: i64,
    pub paused: bool,
    pub wgc_frames: u64,
    pub frames_written: u64,
    pub frames_repeated: u64,
    pub dropped_full: u64,
    pub merged: u64,
}

/// Screen numbers for the report.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ScreenNumbers {
    pub frames_seen: u64,
    pub frames_sent: u64,
    pub merged: u64,
    pub dropped_full: u64,
    pub copy_failed: u64,
    pub copy_avg_ms: f64,
    pub copy_max_ms: f64,
    pub latency_avg_ms: f64,
    pub latency_max_ms: f64,
    /// Largest amount a WGC timestamp was ahead of QPC now at arrival.
    pub ahead_max_ms: f64,
    pub max_gap_ms: f64,
}

#[derive(Debug, Clone)]
pub struct StopReport {
    pub dir: PathBuf,
    pub duration_us: i64,
    pub frames_written: u64,
    pub frames_repeated: u64,
    /// Mic silence added for gaps and to reach the duration (large after a device loss).
    pub mic_padded_us: i64,
    /// Frames the duration asks for (`end_index + 1`).
    pub expected_frames: u64,
    pub screen_offset_us: i64,
    pub mic: Option<MicReport>,
    pub screen: ScreenNumbers,
    pub zooms: usize,
}

#[derive(Default)]
struct ZoomState {
    active: Option<String>,
    marks: Vec<LiveZoomMark>,
    /// Preset frames moved or resized live (`set_preset_rect`), by preset id.
    edited: Vec<(String, NormRect)>,
}

impl ZoomState {
    fn edited_rect(&self, id: &str) -> Option<NormRect> {
        self.edited.iter().find(|(p, _)| p == id).map(|(_, r)| r.clone())
    }
}

type WriterThread = JoinHandle<(ScreenEncoder, io::Result<()>)>;

/// What `start` has running so far, so a failure can stop it in reverse order.
struct Partial {
    dir: PathBuf,
    created_dir: bool,
    encoder: Option<ScreenEncoder>,
    input: Option<InputHandle>,
    mic: Option<MicHandle>,
    system: Option<MicHandle>,
    screen: Option<ScreenHandle>,
    /// The session's own frame sender (for the static-screen slot 0). Dropped before the writer is joined.
    frames_tx: Option<SyncSender<SlotFrame>>,
    writer: Option<WriterThread>,
}

impl Partial {
    fn abort(mut self) {
        if let Some(s) = self.screen.take() {
            let _ = s.stop(); // drops the capture's frame sender
        }
        drop(self.frames_tx.take()); // the last sender: the writer loop ends
        if let Some(w) = self.writer.take()
            && let Ok((enc, _)) = w.join()
        {
            let _ = enc.finish();
        }
        if let Some(enc) = self.encoder.take() {
            let _ = enc.finish();
        }
        if let Some(m) = self.mic.take() {
            let _ = m.stop(0);
        }
        if let Some(m) = self.system.take() {
            let _ = m.stop(0);
        }
        if let Some(i) = self.input.take() {
            let _ = i.stop();
        }
        if self.created_dir {
            let _ = fs::remove_dir_all(&self.dir);
        } else {
            let _ = fs::remove_file(self.dir.join(CRASH_MARKER));
        }
    }
}

/// Everything the forwarder thread touches.
struct Forwarder {
    stop: Arc<AtomicBool>,
    on_event: OnEvent,
    warn_rx: mpsc::Receiver<String>,
    hk_rx: mpsc::Receiver<Hotkey>,
    screen_sh: Arc<ScreenShared>,
    mic_sh: Option<Arc<MicShared>>,
    wstats: Arc<WriterStats>,
    dir: PathBuf,
    meta: ProjectMeta,
}

impl Forwarder {
    /// Runs until `stop`; hands the warnings receiver back so `Session::stop` can drain it.
    fn run(mut self) -> mpsc::Receiver<String> {
        let mut marker_done = false;
        let mut failed_sent = false;
        loop {
            let stopping = self.stop.load(Ordering::SeqCst);
            for w in self.warn_rx.try_iter() {
                (self.on_event)(SessionEvent::Warning(w));
            }
            if stopping {
                break;
            }
            for h in self.hk_rx.try_iter() {
                (self.on_event)(SessionEvent::Hotkey(h));
            }
            if let Some(m) = &self.mic_sh {
                (self.on_event)(SessionEvent::MicLevel(m.level()));
            }
            if !marker_done {
                marker_done = self.rewrite_marker();
            }
            if !failed_sent && self.wstats.failed.load(Ordering::SeqCst) {
                failed_sent = true;
                (self.on_event)(SessionEvent::Failed(ENCODER_STOPPED.to_string()));
            }
            thread::sleep(TICK);
        }
        self.warn_rx
    }

    /// Once the first screen frame and the first mic packet after t0 are known, write the real
    /// offsets into the crash marker so a recovered project keeps them. True when done.
    fn rewrite_marker(&mut self) -> bool {
        let Some(screen_us) = self.screen_sh.first_rec_us() else { return false };
        let mic_us = match &self.mic_sh {
            None => None,
            Some(m) => match m.first_rec_us() {
                Some(us) => Some(us),
                None if m.lost.load(Ordering::SeqCst) => Some(0),
                None => return false,
            },
        };
        self.meta.screen_offset_us = screen_us;
        if let (Some(meta_mic), Some(us)) = (self.meta.mic.as_mut(), mic_us) {
            meta_mic.offset_us = us;
        }
        // A failed rewrite keeps the start marker; recovery still works with zero offsets.
        let _ = project::write_crash_marker(&self.dir, &self.meta);
        true
    }
}

/// A running recording. Call `stop` to finish it; dropping it without `stop` leaves the threads
/// running until the process ends (the crash marker then allows recovery).
pub struct Session {
    dir: PathBuf,
    meta: ProjectMeta,
    encoder_name: String,
    warm_up_ms: f64,
    clock: SharedClock,
    screen_sh: Arc<ScreenShared>,
    mic_sh: Option<Arc<MicShared>>,
    input_sh: Arc<InputShared>,
    screen: ScreenHandle,
    mic: Option<MicHandle>,
    /// The computer's sound, when it was asked for and started.
    system: Option<MicHandle>,
    input: InputHandle,
    /// A second frame sender so the writer keeps running after WGC stops, until `stop` has
    /// written the static-screen slot 0 if no frame arrived after t0.
    frames_tx: SyncSender<SlotFrame>,
    writer: WriterThread,
    end_idx: Arc<AtomicU64>,
    wstats: Arc<WriterStats>,
    ffmpeg_pid: u32,
    zoom: Mutex<ZoomState>,
    fwd_stop: Arc<AtomicBool>,
    fwd: JoinHandle<mpsc::Receiver<String>>,
    on_event: OnEvent,
}

/// `Ok` value, or abort everything started so far and return the error.
macro_rules! or_abort {
    ($partial:expr, $res:expr) => {
        match $res {
            Ok(v) => v,
            Err(e) => {
                $partial.abort();
                return Err(e.into());
            }
        }
    };
}

impl Session {
    /// Start recording. Returns once t0 is taken and `Recording` was emitted.
    pub fn start(opts: RecordOptions, on_event: Box<dyn Fn(SessionEvent) + Send + Sync>) -> Result<Session, CaptureError> {
        let on_event: OnEvent = Arc::from(on_event);
        set_dpi_awareness();
        if opts.fps == 0 || opts.fps > 240 {
            return Err(CaptureError::User("Pick a frame rate between 1 and 240.".into()));
        }
        // Validate the region here so the person sees the plain sentence.
        let monitor = list_monitors()
            .into_iter()
            .find(|m| m.index == opts.monitor)
            .ok_or_else(|| CaptureError::User(SCREEN_NOT_FOUND.into()))?;
        let region = opts.region.map(|r| normalize_region(r, monitor.width, monitor.height)).transpose().map_err(CaptureError::User)?;
        let rect = screen::capture_rect(opts.monitor, region)?;
        let (w, h) = rect.size();
        // Above 2560 x 1440 the recording runs at 30 fps; the bar says so before Record.
        let fps = capture_fps(w, h, opts.fps);

        // Folder and crash marker.
        let dir = opts.out_dir.join(format!("{}.marz", opts.name));
        let existed = dir.exists();
        if existed && fs::read_dir(&dir)?.next().is_some() {
            return Err(CaptureError::User(NAME_TAKEN.into()));
        }
        fs::create_dir_all(&dir)?;
        let mut p = Partial { dir: dir.clone(), created_dir: !existed, encoder: None, input: None, mic: None, system: None, screen: None, frames_tx: None, writer: None };
        let created_at = project::iso_utc_now();
        let meta = ProjectMeta {
            id: new_guid(),
            name: opts.name.clone(),
            created_at: created_at.clone(),
            duration_us: 0,
            width: w,
            height: h,
            fps,
            screen_offset_us: 0,
            mic: opts.mic_id.as_ref().map(|_| MicMeta { offset_us: 0 }),
            system_audio: false,
            cursor_hidden: opts.cursor_hidden,
            presets: opts.presets.clone(),
            zooms: Vec::new(),
        };
        or_abort!(p, project::write_crash_marker(&dir, &meta));

        // FFmpeg.
        let ffmpeg_path = or_abort!(p, ffmpeg::find_ffmpeg());
        let encoder_name = opts.encoder.clone().unwrap_or_else(|| ffmpeg::probe_encoder(&ffmpeg_path));
        let args = ffmpeg::screen_args(&encoder_name, w, h, fps, &dir.join("screen.mp4"));
        let encoder = or_abort!(p, ScreenEncoder::spawn(&ffmpeg_path, &args));
        let ffmpeg_pid = encoder.id();
        p.encoder = Some(encoder);

        // Capture threads; all throw data away until the clock is set.
        let clock = new_clock();
        let (warn_tx, warn_rx) = mpsc::channel::<String>();
        let (hk_tx, hk_rx) = mpsc::channel::<Hotkey>();
        let input_sh = InputShared::new(clock.clone(), hk_tx, warn_tx.clone());
        p.input = Some(or_abort!(p, input::start(input_sh.clone(), true)));
        let mic_sh = opts.mic_id.as_ref().map(|_| MicShared::new(clock.clone(), warn_tx.clone()));
        if let (Some(id), Some(sh)) = (opts.mic_id.as_deref(), &mic_sh) {
            match mic::start(Some(id), &dir.join("mic.wav"), sh.clone()) {
                Ok(m) => p.mic = Some(m),
                Err(_) => {
                    p.abort();
                    on_event(SessionEvent::Failed(MIC_DID_NOT_START.into()));
                    return Err(CaptureError::User(MIC_DID_NOT_START.into()));
                }
            }
        }
        // The computer's sound is optional: if loopback cannot start, record without it and say so.
        // It is not part of the warm-up (loopback sends nothing while nothing plays).
        let mut meta = meta;
        if opts.system_audio {
            match mic::start_system(&dir.join("system.wav"), MicShared::new(clock.clone(), warn_tx.clone())) {
                Ok(m) => {
                    p.system = Some(m);
                    meta.system_audio = true;
                    let _ = project::write_crash_marker(&dir, &meta);
                }
                Err(_) => {
                    let _ = fs::remove_file(dir.join("system.wav"));
                    let _ = warn_tx.send(SYSTEM_DID_NOT_START.to_string());
                }
            }
        }
        let screen_sh = ScreenShared::new(clock.clone(), warn_tx);
        let (cap_ends, writer_ends) = writer::frame_pipe();
        p.frames_tx = Some(cap_ends.frames.clone());
        let warm_start = Instant::now();
        p.screen = Some(or_abort!(p, screen::start(rect, fps, cap_ends, screen_sh.clone())));
        let end_idx = writer::new_end_idx();
        let wstats = Arc::new(WriterStats::default());
        {
            let (e, s) = (end_idx.clone(), wstats.clone());
            let enc = p.encoder.take().expect("encoder spawned above");
            let spawned = thread::Builder::new().name("marz-writer".into()).spawn(move || writer::run_writer(writer_ends, enc, fps, e, s));
            p.writer = Some(or_abort!(p, spawned));
        }

        // Warm-up: both tracks deliver before t0.
        let mic_warm = || mic_sh.as_ref().is_none_or(|m| m.is_warm());
        while !(screen_sh.is_warm() && mic_warm()) && warm_start.elapsed() < WARM_TIMEOUT {
            thread::sleep(Duration::from_millis(5));
        }
        if !(screen_sh.is_warm() && mic_warm()) {
            let msg = if mic_warm() { SCREEN_DID_NOT_START } else { MIC_DID_NOT_START };
            p.abort();
            on_event(SessionEvent::Failed(msg.into()));
            return Err(CaptureError::User(msg.into()));
        }
        let warm_up_ms = warm_start.elapsed().as_secs_f64() * 1000.0;

        // t0, then the events header.
        let events_file = or_abort!(p, File::create(dir.join("events.jsonl")));
        let t0 = qpc_hns();
        if let Ok(mut c) = clock.lock() {
            *c = Some(RecClock::new(t0));
        }
        // startedAt is t0 (createdAt was taken before the FFmpeg probe and can be seconds earlier).
        let header = EventsHeader { width: w, height: h, fps, started_at: project::iso_utc_now() };
        let log = or_abort!(p, EventLog::new(BufWriter::new(events_file), header, rect.origin, fps));
        if let Ok(mut g) = input_sh.log.lock() {
            *g = Some(log);
        }

        let fwd_stop = Arc::new(AtomicBool::new(false));
        let fwd = Forwarder {
            stop: fwd_stop.clone(),
            on_event: on_event.clone(),
            warn_rx,
            hk_rx,
            screen_sh: screen_sh.clone(),
            mic_sh: mic_sh.clone(),
            wstats: wstats.clone(),
            dir: dir.clone(),
            meta: meta.clone(),
        };
        let fwd = or_abort!(p, thread::Builder::new().name("marz-session".into()).spawn(move || fwd.run()));

        let Partial { input, mic, system, screen, frames_tx, writer, .. } = p;
        let session = Session {
            dir,
            meta,
            encoder_name,
            warm_up_ms,
            clock,
            screen_sh,
            mic_sh,
            input_sh,
            screen: screen.expect("started"),
            mic,
            system,
            input: input.expect("started"),
            frames_tx: frames_tx.expect("created"),
            writer: writer.expect("started"),
            end_idx,
            wstats,
            ffmpeg_pid,
            zoom: Mutex::new(ZoomState::default()),
            fwd_stop,
            fwd,
            on_event,
        };
        (session.on_event)(SessionEvent::Recording);
        Ok(session)
    }

    /// The project folder (`<out_dir>/<name>.marz`).
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    /// The FFmpeg encoder in use.
    pub fn encoder(&self) -> &str {
        &self.encoder_name
    }

    /// Time from starting the capture threads until both delivered (before t0).
    pub fn warm_up_ms(&self) -> f64 {
        self.warm_up_ms
    }

    /// The FFmpeg process id (for CPU measurements).
    pub fn ffmpeg_pid(&self) -> u32 {
        self.ffmpeg_pid
    }

    pub fn progress(&self) -> Progress {
        let now = qpc_hns();
        let (rec_us, paused) = self
            .clock
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| (c.duration_us(now), c.is_paused())))
            .unwrap_or((0, false));
        let st = &self.screen_sh.stats;
        Progress {
            rec_us,
            paused,
            wgc_frames: st.frames_seen.load(Ordering::Relaxed),
            frames_written: self.wstats.written.load(Ordering::Relaxed),
            frames_repeated: self.wstats.repeated.load(Ordering::Relaxed),
            dropped_full: st.dropped_full.load(Ordering::Relaxed),
            merged: st.merged.load(Ordering::Relaxed),
        }
    }

    /// Write one line to the events log (clock already released by the caller).
    fn log(&self, f: impl FnOnce(&mut EventLog<BufWriter<File>>)) {
        if let Ok(mut g) = self.input_sh.log.lock()
            && let Some(log) = g.as_mut()
        {
            f(log);
        }
    }

    /// Pause. A `pause` line is written with the recording time at the pause. Ignored while paused.
    pub fn pause(&self) {
        let now = qpc_hns();
        let t = {
            let Ok(mut g) = self.clock.lock() else { return };
            let Some(c) = g.as_mut() else { return };
            if c.is_paused() {
                return;
            }
            let t = c.duration_us(now);
            c.pause(now);
            t
        };
        self.log(|l| l.pause(t));
    }

    /// Resume. The `resume` line has the same `tUs` as its `pause`. Ignored while running.
    pub fn resume(&self) {
        let now = qpc_hns();
        let t = {
            let Ok(mut g) = self.clock.lock() else { return };
            let Some(c) = g.as_mut() else { return };
            if !c.is_paused() {
                return;
            }
            let t = c.duration_us(now);
            c.resume(now);
            t
        };
        self.log(|l| l.resume(t));
    }

    pub fn is_paused(&self) -> bool {
        self.clock.lock().ok().and_then(|g| g.as_ref().map(RecClock::is_paused)).unwrap_or(false)
    }

    /// Mute writes silence in place of the mic audio; the mic track keeps its length.
    pub fn set_mic_muted(&self, muted: bool) {
        if let Some(m) = &self.mic_sh {
            m.set_muted(muted);
        }
    }

    pub fn is_mic_muted(&self) -> bool {
        self.mic_sh.as_ref().is_some_and(|m| m.muted.load(Ordering::SeqCst))
    }

    /// Live zoom: `Some(id)` zooms into that preset, `None` zooms out of the active one. Unknown
    /// presets, a zoom out with no zoom active, and calls while paused are ignored.
    pub fn zoom(&self, preset_id: Option<&str>) {
        // Time is read under the zoom lock, so marks are in time order. Lock order: zoom, clock
        // (released), log; the input thread never takes the zoom lock.
        let Ok(mut z) = self.zoom.lock() else { return };
        let now = qpc_hns();
        let Some(t) = self.clock.lock().ok().and_then(|g| g.as_ref().and_then(|c| c.rec_hns(now))).map(|h| h / 10) else {
            return;
        };
        match preset_id {
            Some(id) => {
                if !self.meta.presets.iter().any(|p| p.id == id) {
                    return;
                }
                self.log(|l| l.zoom(t, id, ZoomAction::In));
                z.active = Some(id.to_string());
                let rect = z.edited_rect(id);
                z.marks.push(LiveZoomMark { t_us: t, preset_id: Some(id.to_string()), rect });
            }
            None => {
                let Some(active) = z.active.take() else { return };
                self.log(|l| l.zoom(t, &active, ZoomAction::Out));
                z.marks.push(LiveZoomMark { t_us: t, preset_id: None, rect: None });
            }
        }
    }

    /// Move or resize preset `preset_id` live. The zoom running on it now takes the new frame, and
    /// so does every later zoom to it; zooms that already ended keep theirs. The project's preset
    /// list gets the last frame. Unknown presets are ignored.
    pub fn set_preset_rect(&self, preset_id: &str, rect: NormRect) {
        if !self.meta.presets.iter().any(|p| p.id == preset_id) {
            return;
        }
        let Ok(mut z) = self.zoom.lock() else { return };
        match z.edited.iter_mut().find(|(p, _)| p == preset_id) {
            Some(e) => e.1 = rect.clone(),
            None => z.edited.push((preset_id.to_string(), rect.clone())),
        }
        if z.active.as_deref() == Some(preset_id)
            && let Some(last) = z.marks.last_mut()
            && last.preset_id.as_deref() == Some(preset_id)
        {
            last.rect = Some(rect);
        }
    }

    /// Register or unregister the recorder hotkeys (they are on when the session starts).
    pub fn set_hotkeys_enabled(&self, on: bool) {
        self.input.set_hotkeys_enabled(on);
    }

    /// Make the mic take its device-lost path now (warning, clean stop, padding at stop).
    /// For the `--simulate-mic-loss-at` test flag; a real unplug takes the same path.
    pub fn simulate_mic_loss(&self) {
        if let Some(m) = &self.mic_sh {
            m.simulate_loss();
        }
    }

    /// Ignore screen frames from now on, as on a static screen (the `--simulate-static-screen`
    /// test flag): exercises the stop path that writes the last warm-up frame as slot 0.
    pub fn simulate_static_screen(&self) {
        self.screen_sh.simulate_static();
    }

    /// Stop and finish every file. On an error the crash marker stays, so `recover` can rebuild
    /// the project from what is on disk.
    pub fn stop(self) -> Result<StopReport, CaptureError> {
        let t_stop = qpc_hns();
        let duration_us = self.clock.lock().ok().and_then(|g| g.as_ref().map(|c| c.duration_us(t_stop))).unwrap_or(0);
        let slotter = Slotter::new(self.meta.fps);
        let end_for = |offset_us: i64| slotter.end_index(duration_us - offset_us);
        // Before WGC stops, so the writer pads to the end and drops frames past it.
        self.end_idx.store(end_for(self.screen_sh.first_rec_us().unwrap_or(0)), Ordering::SeqCst);

        let Session { dir, mut meta, screen_sh, input, screen, mic, system, frames_tx, writer, end_idx, wstats, zoom, fwd_stop, fwd, on_event, .. } = self;
        fwd_stop.store(true, Ordering::SeqCst);
        let warn_rx = fwd.join().ok();

        let mut first_err: Option<CaptureError> = None;
        let mut keep = |r: Result<(), CaptureError>| {
            if let Err(e) = r
                && first_err.is_none()
            {
                first_err = Some(e);
            }
        };
        keep(screen.stop());
        // WGC is stopped, so the first frame time is final. A static screen sends nothing after t0:
        // then the last warm-up frame is slot 0 at offset 0, and the writer pads it to the end.
        let screen_first = screen_sh.first_rec_us();
        let screen_offset_us = screen_first.unwrap_or(0);
        let end = end_for(screen_offset_us);
        end_idx.store(end, Ordering::SeqCst);
        let mut have_frames = screen_first.is_some();
        if !have_frames && let Some(px) = screen_sh.take_warm_frame() {
            have_frames = frames_tx.send((0, px)).is_ok();
        }
        drop(frames_tx); // the last sender: the writer pads and ends
        let encoder = match writer.join() {
            Ok((enc, res)) => {
                keep(res.map_err(|e| CaptureError::Encoder(format!("writing frames to ffmpeg failed: {e}"))));
                Some(enc)
            }
            Err(_) => {
                keep(Err(CaptureError::Encoder("the frame writer thread panicked".into())));
                None
            }
        };
        // The computer's sound is optional: a failure to finish it drops the track, never the take.
        let system_ok = match system.map(|m| m.stop(duration_us)) {
            Some(Ok(_)) => true,
            Some(Err(e)) => {
                eprintln!("marz-capture: the computer sound track could not be finished: {e}");
                let _ = fs::remove_file(dir.join("system.wav"));
                false
            }
            None => false,
        };
        let mic_report = match mic.map(|m| m.stop(duration_us)) {
            Some(Ok(r)) => Some(r),
            Some(Err(e)) => {
                keep(Err(e));
                None
            }
            None => None,
        };
        keep(input.stop());
        if let Some(enc) = encoder {
            keep(enc.finish());
        }
        if !have_frames {
            keep(Err(CaptureError::Encoder("no screen frames arrived".into())));
        }

        if let Some(rx) = warn_rx {
            for w in rx.try_iter() {
                on_event(SessionEvent::Warning(w));
            }
        }
        if let Some(r) = &mic_report
            && r.first_rec_us.is_none()
        {
            on_event(SessionEvent::Warning(MIC_SILENT.into()));
        }
        if let Some(e) = first_err {
            return Err(e);
        }

        let (marks, edited) = zoom.into_inner().map(|z| (z.marks, z.edited)).unwrap_or_default();
        meta.duration_us = duration_us;
        meta.screen_offset_us = screen_offset_us;
        meta.mic = mic_report.as_ref().map(|r| MicMeta { offset_us: r.first_rec_us.unwrap_or(0) });
        meta.system_audio = system_ok;
        // Zooms from before an edit keep the preset's original frame (their marks carry no rect).
        meta.zooms = project::live_zooms(&marks, &meta.presets, duration_us);
        for (id, rect) in edited {
            if let Some(p) = meta.presets.iter_mut().find(|p| p.id == id) {
                p.rect = rect;
            }
        }
        project::write_project_json(&dir, &meta)?;
        // project.json is written, so the recording is safe: a marker that will not go away is
        // only noise (`needs_recovery` is false while project.json exists). Never fail the stop on it.
        if let Err(e) = fs::remove_file(dir.join(CRASH_MARKER)) {
            eprintln!("marz-capture: could not remove the crash marker in {}: {e}", dir.display());
        }

        let st = &screen_sh.stats;
        let ms = |hns: u64| hns as f64 / 1e4;
        let avg = |sum: u64, n: u64| if n == 0 { 0.0 } else { ms(sum) / n as f64 };
        let seen = st.frames_seen.load(Ordering::Relaxed);
        let copied = st.frames_copied.load(Ordering::Relaxed);
        let screen_numbers = ScreenNumbers {
            frames_seen: seen,
            frames_sent: st.frames_sent.load(Ordering::Relaxed),
            merged: st.merged.load(Ordering::Relaxed),
            dropped_full: st.dropped_full.load(Ordering::Relaxed),
            copy_failed: st.copy_failed.load(Ordering::Relaxed),
            copy_avg_ms: avg(st.copy_sum_hns.load(Ordering::Relaxed), copied),
            copy_max_ms: ms(st.copy_max_hns.load(Ordering::Relaxed)),
            latency_avg_ms: avg(st.latency_sum_hns.load(Ordering::Relaxed), seen),
            latency_max_ms: ms(st.latency_max_hns.load(Ordering::Relaxed)),
            ahead_max_ms: ms(st.ahead_max_hns.load(Ordering::Relaxed)),
            max_gap_ms: ms(st.max_gap_hns.load(Ordering::Relaxed)),
        };
        Ok(StopReport {
            dir,
            duration_us,
            frames_written: wstats.written.load(Ordering::Relaxed),
            frames_repeated: wstats.repeated.load(Ordering::Relaxed),
            mic_padded_us: mic_report.as_ref().map_or(0, |r| r.gap_padded_us + r.end_padded_us),
            expected_frames: end + 1,
            screen_offset_us,
            mic: mic_report,
            screen: screen_numbers,
            zooms: meta.zooms.len(),
        })
    }
}
