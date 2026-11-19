//! Command line front end for the capture engine.
//!
//! ```text
//! marz-capture record <out.marz> [--secs N] [--fps N] [--encoder E] [--monitor N] [--region x,y,w,h]
//!                     [--no-mic] [--mic-id ID] [--system-audio] [--camera-id ID] [--hide-cursor] [--report]
//!                     [--pause-at a,b,...] [--resume-at a,b,...] [--zoom-at a,b,...]
//!                     [--simulate-mic-loss-at SECS] [--simulate-static-screen] [--sync-probe]
//! marz-capture recover <dir>
//! marz-capture --list-cameras
//! ```
//!
//! Times in the `--*-at` flags are wall-clock seconds after recording started. `--zoom-at`
//! alternates zoom in (built-in preset "Zoom 1", the centre quarter) and zoom out. Hotkeys work
//! while recording: Ctrl+Shift+R stops, Ctrl+Shift+P pauses or resumes, Ctrl+Shift+M mutes,
//! Ctrl+1 zooms, Ctrl+0 zooms out.
//!
//! `--sync-probe` covers the monitor with a black window that flashes white and beeps every 3 s
//! (first flash 2 s in), and writes `sync-probe.json` beside the project. Run `--secs 63` and then
//! `pnpm sync-check <out.marz>`. It plays sound and flashes the whole screen: leave the PC alone.

const USAGE: &str = "usage:
  marz-capture record <out.marz> [--secs N] [--fps N] [--encoder E] [--monitor N] [--region x,y,w,h]
                      [--no-mic] [--mic-id ID] [--system-audio] [--camera-id ID] [--hide-cursor] [--report]
                      [--pause-at a,b,...] [--resume-at a,b,...] [--zoom-at a,b,...]
                      [--simulate-mic-loss-at SECS] [--simulate-static-screen] [--sync-probe]
  marz-capture recover <dir>
  marz-capture --list-cameras";

#[cfg(not(windows))]
fn main() {
    eprintln!("marz-capture records on Windows only.\n{USAGE}");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match cli::run(&args) {
        Ok(()) => 0,
        Err(cli::CliError::Usage(msg)) => {
            eprintln!("{msg}\n{USAGE}");
            2
        }
        Err(cli::CliError::Shown) => 1,
        Err(cli::CliError::Capture(e)) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
mod cli {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use marz_capture::CaptureError;
    use marz_capture::project::{NormRect, ZoomPreset};
    use marz_capture::recover::{needs_recovery, recover};
    use marz_capture::region::PxRect;
    use marz_capture::win::camera::{camera_modes, list_cameras};
    use marz_capture::win::input::Hotkey;
    use marz_capture::win::mic::list_mics;
    use marz_capture::win::monitors::list_monitors;
    use marz_capture::win::session::{RecordOptions, Session, SessionEvent, StopReport};
    use marz_capture::win::sync_probe;
    use marz_capture::win::set_dpi_awareness;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub enum CliError {
        Usage(String),
        /// The reason was already printed (a `Failed` event).
        Shown,
        Capture(CaptureError),
    }

    impl From<CaptureError> for CliError {
        fn from(e: CaptureError) -> Self {
            CliError::Capture(e)
        }
    }

    impl From<std::io::Error> for CliError {
        fn from(e: std::io::Error) -> Self {
            CliError::Capture(e.into())
        }
    }

    pub fn run(args: &[String]) -> Result<(), CliError> {
        match args.first().map(String::as_str) {
            Some("record") => record(parse_record(&args[1..])?),
            Some("--list-cameras") => {
                for c in list_cameras() {
                    println!("camera: {}\n  id: {}", c.name, c.id);
                    match camera_modes(&c.id) {
                        Ok((modes, pick)) => {
                            for m in modes {
                                println!("  {:>2} {} {}x{} {:.2} fps", m.index, if m.nv12 { "NV12" } else { "other" }, m.width, m.height, m.fps);
                            }
                            if let Some(m) = pick {
                                println!("  records: {}x{} (mode {})", m.width, m.height, m.index);
                            }
                        }
                        Err(e) => println!("  could not open: {e}"),
                    }
                }
                Ok(())
            }
            Some("recover") => {
                let dir = args.get(1).ok_or_else(|| CliError::Usage("recover needs a folder".into()))?;
                recover_cmd(Path::new(dir))
            }
            Some(other) => Err(CliError::Usage(format!("unknown command: {other}"))),
            None => Err(CliError::Usage("no command".into())),
        }
    }

    struct RecordArgs {
        out: PathBuf,
        secs: f64,
        fps: u32,
        encoder: Option<String>,
        monitor: Option<usize>,
        region: Option<PxRect>,
        no_mic: bool,
        mic_id: Option<String>,
        cursor_hidden: bool,
        system_audio: bool,
        camera_id: Option<String>,
        report: bool,
        pause_at: Vec<f64>,
        resume_at: Vec<f64>,
        zoom_at: Vec<f64>,
        mic_loss_at: Option<f64>,
        simulate_static: bool,
        sync_probe: bool,
    }

    fn parse_record(args: &[String]) -> Result<RecordArgs, CliError> {
        let usage = |m: String| CliError::Usage(m);
        let mut it = args.iter();
        let out = PathBuf::from(it.next().ok_or_else(|| usage("record needs an output folder".into()))?);
        let mut a = RecordArgs {
            out,
            secs: 20.0,
            fps: 60,
            encoder: None,
            monitor: None,
            region: None,
            no_mic: false,
            mic_id: None,
            cursor_hidden: false,
            system_audio: false,
            camera_id: None,
            report: false,
            pause_at: Vec::new(),
            resume_at: Vec::new(),
            zoom_at: Vec::new(),
            mic_loss_at: None,
            simulate_static: false,
            sync_probe: false,
        };
        fn num<T: std::str::FromStr>(flag: &str, v: Option<&String>) -> Result<T, CliError> {
            v.and_then(|s| s.trim().parse().ok()).ok_or_else(|| CliError::Usage(format!("{flag} needs a number")))
        }
        fn list(flag: &str, v: Option<&String>) -> Result<Vec<f64>, CliError> {
            let s = v.ok_or_else(|| CliError::Usage(format!("{flag} needs a list")))?;
            s.split(',').map(|x| x.trim().parse().map_err(|_| CliError::Usage(format!("{flag}: {x} is not a number")))).collect()
        }
        while let Some(flag) = it.next() {
            match flag.as_str() {
                "--secs" => a.secs = num(flag, it.next())?,
                "--fps" => a.fps = num(flag, it.next())?,
                "--encoder" => a.encoder = Some(it.next().ok_or_else(|| usage("--encoder needs a name".into()))?.clone()),
                "--monitor" => a.monitor = Some(num(flag, it.next())?),
                "--region" => {
                    let v = list(flag, it.next())?;
                    let [x, y, w, h] = v[..] else { return Err(usage("--region needs x,y,w,h".into())) };
                    if w < 0.0 || h < 0.0 {
                        return Err(usage("--region width and height must be positive".into()));
                    }
                    a.region = Some(PxRect { x: x as i32, y: y as i32, w: w as u32, h: h as u32 });
                }
                "--no-mic" => a.no_mic = true,
                "--mic-id" => a.mic_id = Some(it.next().ok_or_else(|| usage("--mic-id needs an id".into()))?.clone()),
                "--hide-cursor" => a.cursor_hidden = true,
                "--system-audio" => a.system_audio = true,
                "--camera-id" => a.camera_id = Some(it.next().ok_or_else(|| usage("--camera-id needs an id (see --list-cameras)".into()))?.clone()),
                "--report" => a.report = true,
                "--pause-at" => a.pause_at = list(flag, it.next())?,
                "--resume-at" => a.resume_at = list(flag, it.next())?,
                "--zoom-at" => a.zoom_at = list(flag, it.next())?,
                "--simulate-mic-loss-at" => a.mic_loss_at = Some(num(flag, it.next())?),
                "--simulate-static-screen" => a.simulate_static = true,
                "--sync-probe" => a.sync_probe = true,
                other => return Err(usage(format!("unknown flag: {other}"))),
            }
        }
        Ok(a)
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Action {
        Pause,
        Resume,
        ZoomIn,
        ZoomOut,
        MicLoss,
    }

    const PRESET_ID: &str = "zoom-1";

    fn record(a: RecordArgs) -> Result<(), CliError> {
        set_dpi_awareness();
        let monitors = list_monitors();
        let monitor = match a.monitor {
            Some(m) => m,
            None => monitors.iter().find(|m| m.primary).map_or(0, |m| m.index),
        };
        if let Some(m) = monitors.iter().find(|m| m.index == monitor) {
            println!("monitor: {} {}x{} @ {} Hz, origin ({}, {})", m.name, m.width, m.height, m.refresh_hz, m.x, m.y);
        }
        let mic_id = if a.no_mic {
            None
        } else if a.mic_id.is_some() {
            a.mic_id.clone()
        } else {
            let id = list_mics().into_iter().find(|m| m.default).map(|m| m.id);
            if id.is_none() {
                println!("warning: No microphone found. Recording without sound.");
            }
            id
        };
        let name = a.out.file_stem().map(|s| s.to_string_lossy().into_owned()).ok_or_else(|| CliError::Usage("bad output folder".into()))?;
        let out_dir = a.out.parent().filter(|p| !p.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        fs::create_dir_all(&out_dir)?;
        let opts = RecordOptions {
            out_dir,
            name,
            monitor,
            region: a.region,
            fps: a.fps,
            mic_id,
            cursor_hidden: a.cursor_hidden,
            system_audio: a.system_audio,
            camera_id: a.camera_id.clone(),
            presets: vec![ZoomPreset { id: PRESET_ID.into(), name: "Zoom 1".into(), rect: NormRect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }],
            encoder: a.encoder.clone(),
        };

        // The probe window goes up before the recording starts, so the screen is black from t0.
        let mut probe = None;
        if a.sync_probe {
            if opts.mic_id.is_none() {
                return Err(CliError::Usage("--sync-probe needs the microphone (drop --no-mic)".into()));
            }
            let m = monitors.iter().find(|m| m.index == monitor).ok_or_else(|| CliError::Usage(format!("no monitor {monitor}")))?;
            probe = Some(sync_probe::start((m.x, m.y), (m.width, m.height))?);
            println!("sync probe: black window over the monitor, a white flash and a beep every {} s from 2 s in. Leave the PC alone.", sync_probe::INTERVAL_S);
        }

        let (tx, rx) = mpsc::channel::<SessionEvent>();
        let session = match Session::start(opts, Box::new(move |e| {
            let _ = tx.send(e);
        })) {
            Ok(s) => s,
            Err(e) => {
                let mut shown = false;
                for ev in rx.try_iter() {
                    shown |= print_event(&ev);
                }
                return Err(if shown { CliError::Shown } else { e.into() });
            }
        };
        if a.simulate_static {
            session.simulate_static_screen();
        }
        let started = Instant::now();
        let encoder = session.encoder().to_string();
        println!("encoder: {encoder}");
        println!("warm-up: {:.0} ms", session.warm_up_ms());
        println!("recording to {}", session.dir().display());

        let mut plan: Vec<(f64, Action)> = Vec::new();
        plan.extend(a.pause_at.iter().map(|&t| (t, Action::Pause)));
        plan.extend(a.resume_at.iter().map(|&t| (t, Action::Resume)));
        plan.extend(a.zoom_at.iter().enumerate().map(|(i, &t)| (t, if i % 2 == 0 { Action::ZoomIn } else { Action::ZoomOut })));
        plan.extend(a.mic_loss_at.map(|t| (t, Action::MicLoss)));
        plan.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut plan = plan.into_iter().peekable();

        let me = unsafe { GetCurrentProcess() };
        let ff = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, session.ffmpeg_pid()) }.ok();
        let cpu0 = cpu_s(me);
        let ffcpu0 = ff.map_or(0.0, cpu_s);
        let mut paused_since: Option<Instant> = None;
        let mut paused_total = Duration::ZERO;
        let mut next_progress = 10u64;
        let mut failed = false;
        let toggle_pause = |s: &Session, since: &mut Option<Instant>, total: &mut Duration, el: f64| {
            if s.is_paused() {
                s.resume();
                if let Some(p) = since.take() {
                    *total += p.elapsed();
                }
                println!("{el:>8.3}s  resume");
            } else {
                s.pause();
                *since = Some(Instant::now());
                println!("{el:>8.3}s  pause");
            }
        };
        'rec: loop {
            let el = started.elapsed().as_secs_f64();
            if el >= a.secs {
                break;
            }
            while let Some(&(t, act)) = plan.peek() {
                if t > el {
                    break;
                }
                plan.next();
                match act {
                    Action::Pause if !session.is_paused() => toggle_pause(&session, &mut paused_since, &mut paused_total, el),
                    Action::Resume if session.is_paused() => toggle_pause(&session, &mut paused_since, &mut paused_total, el),
                    Action::Pause | Action::Resume => {}
                    Action::ZoomIn => {
                        session.zoom(Some(PRESET_ID));
                        println!("{el:>8.3}s  zoom in");
                    }
                    Action::ZoomOut => {
                        session.zoom(None);
                        println!("{el:>8.3}s  zoom out");
                    }
                    Action::MicLoss => {
                        session.simulate_mic_loss();
                        println!("{el:>8.3}s  simulated mic loss");
                    }
                }
            }
            for ev in rx.try_iter() {
                match ev {
                    SessionEvent::Hotkey(h) => {
                        println!("{el:>8.3}s  hotkey {}", h.label());
                        match h {
                            Hotkey::RecordStop => break 'rec,
                            Hotkey::Pause => toggle_pause(&session, &mut paused_since, &mut paused_total, el),
                            Hotkey::Mute => session.set_mic_muted(!session.is_mic_muted()),
                            Hotkey::Preset(1) => session.zoom(Some(PRESET_ID)),
                            Hotkey::Preset(_) => {}
                            Hotkey::ZoomOut => session.zoom(None),
                            Hotkey::Layout(n) => {
                                if let Some(name) = marz_capture::events::LAYOUTS.get(usize::from(n.saturating_sub(1))) {
                                    session.layout(name);
                                }
                            }
                        }
                    }
                    SessionEvent::Failed(_) => {
                        print_event(&ev);
                        failed = true;
                        break 'rec;
                    }
                    other => {
                        print_event(&other);
                    }
                }
            }
            if el >= next_progress as f64 {
                let p = session.progress();
                println!(
                    "{next_progress:>4}s  wgc {}  written {}  dup {}  dropped {}  rec {:.2}s{}",
                    p.wgc_frames,
                    p.frames_written,
                    p.frames_repeated,
                    p.dropped_full,
                    p.rec_us as f64 / 1e6,
                    if p.paused { "  paused" } else { "" }
                );
                next_progress += 10;
            }
            thread::sleep(Duration::from_millis(5));
        }

        let wall = started.elapsed().as_secs_f64();
        if let Some(p) = paused_since.take() {
            paused_total += p.elapsed();
        }
        let cpu1 = cpu_s(me);
        let ffcpu1 = ff.map_or(0.0, cpu_s);
        let report = session.stop();
        let probe_report = probe.take().map(sync_probe::SyncProbe::stop);
        for ev in rx.try_iter() {
            print_event(&ev);
        }
        let report = report?;
        if let Some(p) = &probe_report {
            print!("{}", p.text());
            fs::write(report.dir.join("sync-probe.json"), p.to_json())?;
        }
        let ffcpu_total = ff.map_or(0.0, cpu_s);
        if let Some(h) = ff {
            let _ = unsafe { CloseHandle(h) };
        }
        let cores = thread::available_parallelism().map_or(1, |n| n.get()) as f64;
        let cpu = Cpu { capture: (cpu1 - cpu0) / wall * 100.0, ffmpeg: (ffcpu1 - ffcpu0) / wall * 100.0, ffmpeg_total_s: ffcpu_total, cores };
        let text = report_text(&report, &a, &encoder, wall, paused_total.as_secs_f64(), &cpu);
        print!("{text}");
        if a.report {
            fs::write(report.dir.join("capture-report.txt"), &text)?;
        }
        if failed {
            return Err(CliError::Shown);
        }
        Ok(())
    }

    /// Prints an event; true when it was a `Failed`.
    fn print_event(ev: &SessionEvent) -> bool {
        match ev {
            SessionEvent::Warning(w) => println!("warning: {w}"),
            SessionEvent::Failed(m) => {
                println!("failed: {m}");
                return true;
            }
            SessionEvent::Hotkey(h) => println!("hotkey {}", h.label()),
            SessionEvent::Recording | SessionEvent::MicLevel(_) => {}
        }
        false
    }

    struct Cpu {
        capture: f64,
        ffmpeg: f64,
        ffmpeg_total_s: f64,
        cores: f64,
    }

    fn report_text(r: &StopReport, a: &RecordArgs, encoder: &str, wall: f64, paused: f64, cpu: &Cpu) -> String {
        let size = |f: &str| fs::metadata(r.dir.join(f)).map_or(0, |m| m.len()) as f64;
        let events = fs::read_to_string(r.dir.join("events.jsonl")).map_or(0, |t| t.lines().count().saturating_sub(1));
        let project: serde_json::Value =
            fs::read_to_string(r.dir.join("project.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let (w, h) = (project["source"]["width"].as_u64().unwrap_or(0), project["source"]["height"].as_u64().unwrap_or(0));
        let s = &r.screen;
        let dur = r.duration_us as f64 / 1e6;
        let mut out = String::from("REPORT\n");
        let mut line = |l: String| {
            out.push_str(&l);
            out.push('\n');
        };
        line(format!("duration_s: {dur:.3} (wall {wall:.3}, paused {paused:.3}, wall minus paused {:.3})", wall - paused));
        let region = a.region.map_or(String::new(), |g| format!(" (region {},{},{},{})", g.x, g.y, g.w, g.h));
        line(format!("source: {w}x{h}{region}, target fps {}, encoder {encoder}", a.fps));
        match &r.mic {
            Some(m) => line(format!("mic device: {}{}", m.device_name, if m.lost { " (lost during the recording)" } else { "" })),
            None => line("mic device: none".into()),
        }
        line(format!(
            "wgc frames: {} ({:.2}/s)  merged(>fps): {}  dropped(queue full): {}  copy failed: {}",
            s.frames_seen,
            s.frames_seen as f64 / wall,
            s.merged,
            s.dropped_full,
            s.copy_failed
        ));
        line(format!("wgc max gap between frames: {:.1} ms", s.max_gap_ms));
        line(format!("gpu->cpu copy per frame: avg {:.2} ms, max {:.2} ms", s.copy_avg_ms, s.copy_max_ms));
        line(format!("wgc frame latency (QPC now - SystemRelativeTime): avg {:.2} ms, max {:.2} ms, ahead of now max {:.2} ms", s.latency_avg_ms, s.latency_max_ms, s.ahead_max_ms));
        line(format!(
            "written frames: {} (expected {}), of which repeats: {} ({:.2}%)",
            r.frames_written,
            r.expected_frames,
            r.frames_repeated,
            r.frames_repeated as f64 * 100.0 / r.frames_written.max(1) as f64
        ));
        let mic_off = r.mic.as_ref().map_or("none".to_string(), |m| m.first_rec_us.unwrap_or(0).to_string());
        line(format!("screen offsetUs: {}  mic offsetUs: {mic_off}", r.screen_offset_us));
        if let Some(m) = &r.mic {
            line(format!(
                "mic samples: {} = {:.3}s  gap padded {} us  end padded {} us",
                m.frames,
                m.frames as f64 / 48_000.0,
                m.gap_padded_us,
                m.end_padded_us
            ));
            line(format!("mic drift (device QPC position vs sample count) after padding: max {} us, at end {} us", m.drift_max_us, m.drift_end_us));
        }
        match &r.camera {
            Some(c) => {
                line(format!(
                    "camera: {}x{}  offsetUs {}  frames seen {}  real fps {:.2}{}",
                    c.width,
                    c.height,
                    c.offset_us,
                    c.frames_seen,
                    c.real_fps,
                    if c.lost { "  (stopped during the recording)" } else { "" }
                ));
                line(format!(
                    "camera written frames: {} (expected {}), of which repeats: {}  camera.mp4 {:.2} MB",
                    c.frames_written,
                    c.expected_frames,
                    c.frames_repeated,
                    size("camera.mp4") / 1e6
                ));
            }
            None => line(format!("camera: {}", if a.camera_id.is_some() { "asked for, not recorded" } else { "none" })),
        }
        line(format!("events written: {events}  live zooms: {}", r.zooms));
        line(format!("cpu capture process: {:.1}% of one core ({:.2}% of {} cores)", cpu.capture, cpu.capture / cpu.cores, cpu.cores));
        line(format!("cpu ffmpeg: {:.1}% of one core during capture; {:.1} s total incl. flush", cpu.ffmpeg, cpu.ffmpeg_total_s));
        line(format!(
            "sizes: screen.mp4 {:.2} MB ({:.2} Mbit/s), mic.wav {:.2} MB, events.jsonl {:.1} KB",
            size("screen.mp4") / 1e6,
            size("screen.mp4") * 8.0 / 1e6 / dur.max(0.001),
            size("mic.wav") / 1e6,
            size("events.jsonl") / 1e3
        ));
        out
    }

    fn cpu_s(h: HANDLE) -> f64 {
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        if unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) }.is_err() {
            return 0.0;
        }
        let ft = |f: FILETIME| ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 1e7;
        ft(k) + ft(u)
    }

    fn recover_cmd(dir: &Path) -> Result<(), CliError> {
        if !needs_recovery(dir) {
            println!("{} does not need recovery (no .recording marker, or project.json exists)", dir.display());
            return Ok(());
        }
        let ffprobe = marz_capture::ffmpeg::find_ffprobe()?;
        let r = recover(dir, &ffprobe)?;
        println!("recovered {}: durationUs {} ({:.3} s)", dir.display(), r.duration_us, r.duration_us as f64 / 1e6);
        Ok(())
    }
}
