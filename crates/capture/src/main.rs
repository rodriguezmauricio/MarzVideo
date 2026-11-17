//! Capture spike (throwaway). Proves the M1 capture approach on Windows:
//! WGC screen frames (windows-capture) piped as raw BGRA to an FFmpeg sidecar,
//! WASAPI mic (wasapi) written straight to a 48 kHz WAV, and a low-level mouse hook
//! for events.jsonl. Every timestamp comes from QueryPerformanceCounter.
//!
//! Usage: marz-capture <out-dir.marz> [--secs N] [--fps N] [--encoder NAME] [--no-test-window]

use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{FILETIME, HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, GetSysColorBrush, MonitorFromPoint, COLOR_HIGHLIGHT, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentThreadId, GetProcessTimes};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::w;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Recording start (t0) on the QPC clock, in 100 ns. i64::MAX until record is "pressed":
/// screen and mic are started first and warm up; anything before t0 is thrown away.
static T0: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MAX);
static SCREEN_WARM: AtomicBool = AtomicBool::new(false);
static MIC_WARM: AtomicBool = AtomicBool::new(false);
fn t0() -> i64 {
    T0.load(Ordering::SeqCst)
}

// ---------- clock: QPC, everything in microseconds or 100 ns ticks ----------

fn qpc_raw() -> i64 {
    let mut v = 0i64;
    unsafe { QueryPerformanceCounter(&mut v).unwrap() };
    v
}
fn qpc_freq() -> i64 {
    let mut f = 0i64;
    unsafe { QueryPerformanceFrequency(&mut f).unwrap() };
    f
}
/// QPC now, in 100 ns ticks (the unit WGC SystemRelativeTime and WASAPI u64QPCPosition use).
fn qpc_hns() -> i64 {
    let (c, f) = (qpc_raw() as i128, qpc_freq() as i128);
    (c * 10_000_000 / f) as i64
}

// ---------- shared stats ----------

#[derive(Default)]
struct Stats {
    wgc_frames: AtomicU64,
    wgc_dropped_full: AtomicU64,
    wgc_merged: AtomicU64,
    latency_sum_hns: AtomicU64,
    latency_max_hns: AtomicU64,
    max_gap_hns: AtomicU64,
    cb_max_hns: AtomicU64,
    copy_sum_hns: AtomicU64,
    copies: AtomicU64,
    written_frames: AtomicU64,
    dup_frames: AtomicU64,
    mic_frames: AtomicU64,
    mic_discontinuities: AtomicU64,
    mic_silent_flags: AtomicU64,
    mic_max_drift_us: AtomicU64,
    mic_last_drift_us: std::sync::atomic::AtomicI64,
    mic_padded_us: AtomicU64,
    events_written: AtomicU64,
}

// ---------- screen ----------

struct ScreenFlags {
    fps: u32,
    tx: SyncSender<(u64, Vec<u8>)>,
    first_ts: Arc<Mutex<Option<i64>>>,
    stats: Arc<Stats>,
}

struct Screen {
    f: ScreenFlags,
    last_ts: Option<i64>,
    last_idx: Option<u64>,
    scratch: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Screen {
    type Flags = ScreenFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { f: ctx.flags, last_ts: None, last_idx: None, scratch: Vec::new() })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
        let now = qpc_hns();
        let ts = frame.timestamp()?.Duration; // 100 ns, QPC based
        let s = &self.f.stats;
        s.wgc_frames.fetch_add(1, Ordering::Relaxed);
        let lat = (now - ts).max(0) as u64;
        s.latency_sum_hns.fetch_add(lat, Ordering::Relaxed);
        s.latency_max_hns.fetch_max(lat, Ordering::Relaxed);
        if let Some(prev) = self.last_ts {
            s.max_gap_hns.fetch_max((ts - prev).max(0) as u64, Ordering::Relaxed);
        }
        self.last_ts = Some(ts);

        SCREEN_WARM.store(true, Ordering::SeqCst);
        if ts < t0() {
            return Ok(()); // composed before record was pressed
        }
        let first = {
            let mut g = self.f.first_ts.lock().unwrap();
            *g.get_or_insert(ts)
        };
        let frame_hns = 10_000_000f64 / self.f.fps as f64;
        let idx = ((ts - first) as f64 / frame_hns).round() as u64;
        if self.last_idx.is_some_and(|l| idx <= l) {
            s.wgc_merged.fetch_add(1, Ordering::Relaxed); // two WGC frames in one output slot
            return Ok(());
        }
        let c0 = qpc_hns();
        let buf = frame.buffer()?;
        let px = buf.as_nopadding_buffer(&mut self.scratch).to_vec();
        drop(buf);
        let c1 = qpc_hns();
        s.copy_sum_hns.fetch_add((c1 - c0) as u64, Ordering::Relaxed);
        s.copies.fetch_add(1, Ordering::Relaxed);
        s.cb_max_hns.fetch_max((c1 - now) as u64, Ordering::Relaxed);
        match self.f.tx.try_send((idx, px)) {
            Ok(()) => self.last_idx = Some(idx),
            Err(TrySendError::Full(_)) => {
                s.wgc_dropped_full.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
        Ok(())
    }
}

/// Writes frames to FFmpeg at a constant rate: gaps (static screen, drops) repeat the last frame.
fn video_writer(rx: Receiver<(u64, Vec<u8>)>, mut stdin: std::process::ChildStdin, end_idx: Arc<AtomicU64>, stats: Arc<Stats>) {
    let mut next: u64 = 0;
    let mut last: Option<Vec<u8>> = None;
    let write = |buf: &[u8], stdin: &mut std::process::ChildStdin| {
        stdin.write_all(buf).expect("ffmpeg stdin");
        stats.written_frames.fetch_add(1, Ordering::Relaxed);
    };
    for (idx, px) in rx {
        if let Some(l) = &last {
            while next < idx {
                write(l, &mut stdin);
                stats.dup_frames.fetch_add(1, Ordering::Relaxed);
                next += 1;
            }
        }
        next = next.max(idx);
        write(&px, &mut stdin);
        next += 1;
        last = Some(px);
    }
    // pad to the stop time so the video covers the whole recording
    let end = end_idx.load(Ordering::SeqCst);
    if let Some(l) = &last {
        while next < end {
            write(l, &mut stdin);
            stats.dup_frames.fetch_add(1, Ordering::Relaxed);
            next += 1;
        }
    }
    drop(stdin);
}

fn pick_encoder(forced: Option<String>) -> String {
    if let Some(e) = forced {
        return e;
    }
    for enc in ["h264_nvenc", "h264_amf", "h264_qsv"] {
        let ok = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:r=30", "-frames:v", "2", "-c:v", enc, "-f", "null", "-"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return enc.to_string();
        }
    }
    "libx264".to_string()
}

fn spawn_ffmpeg(enc: &str, w: u32, h: u32, fps: u32, out: &std::path::Path) -> Res<Child> {
    let size = format!("{w}x{h}");
    let fps_s = fps.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", &size, "-r", &fps_s, "-i", "-"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let enc_args: Vec<&str> = match enc {
        "h264_nvenc" => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
        "libx264" => vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
        other => vec!["-c:v", other],
    };
    args.extend(enc_args.iter().map(|s| s.to_string()));
    args.extend(
        ["-g", &fps_s, "-r", &fps_s, "-movflags", "frag_keyframe+empty_moov+default_base_moof", &out.to_string_lossy()]
            .iter()
            .map(|s| s.to_string()),
    );
    Ok(Command::new("ffmpeg").args(&args).stdin(Stdio::piped()).spawn()?)
}

// ---------- mic ----------

fn write_wav_header(f: &mut File, data_bytes: u32) -> std::io::Result<()> {
    let (rate, ch, bits) = (48_000u32, 1u16, 16u16);
    let block = ch * bits / 8;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_bytes).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&ch.to_le_bytes())?;
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * block as u32).to_le_bytes())?;
    f.write_all(&block.to_le_bytes())?;
    f.write_all(&bits.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_bytes.to_le_bytes())?;
    Ok(())
}

/// Returns (offset of first sample in hns on QPC, device name).
fn mic_thread(path: std::path::PathBuf, stop: Arc<AtomicBool>, stats: Arc<Stats>, first_out: Arc<Mutex<Option<i64>>>) -> Res<String> {
    use std::collections::VecDeque;
    use wasapi::*;
    let _ = initialize_mta();
    let dev = DeviceEnumerator::new()?.get_default_device(Direction::Capture)?;
    let name = dev.get_friendlyname().unwrap_or_default();
    let mut client = dev.get_iaudioclient()?;
    let fmt = WaveFormat::new(16, 16, SampleType::Int, 48_000, 1, None);
    let (_def, min) = client.get_device_period()?;
    client.initialize_client(&fmt, Direction::Capture, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min }, None)?;
    let ev = client.set_get_eventhandle()?;
    let cap = client.get_audiocaptureclient()?;
    let mut file = File::create(&path)?;
    write_wav_header(&mut file, 0)?;
    let mut w = BufWriter::new(file);
    let mut q: VecDeque<u8> = VecDeque::new();
    let mut samples: u64 = 0;
    let mut first: Option<i64> = None;
    client.start_stream()?;
    while !stop.load(Ordering::SeqCst) {
        if ev.wait_for_event(500).is_err() {
            continue;
        }
        loop {
            match cap.get_next_packet_size()? {
                Some(0) | None => break,
                _ => {}
            }
            let before = q.len();
            let info = cap.read_from_device_to_deque(&mut q)?;
            let got = ((q.len() - before) / 2) as u64;
            if got == 0 {
                break;
            }
            if info.flags.data_discontinuity {
                stats.mic_discontinuities.fetch_add(1, Ordering::Relaxed);
            }
            if info.flags.silent {
                stats.mic_silent_flags.fetch_add(1, Ordering::Relaxed);
            }
            let ts = info.timestamp as i64; // 100 ns on QPC
            MIC_WARM.store(true, Ordering::SeqCst);
            let t0_hns = t0();
            if ts < t0_hns && first.is_none() {
                q.clear(); // captured before record was pressed
                continue;
            }
            let f0 = *first.get_or_insert(ts);
            // drift: device position vs. sample count (both measured from the first sample)
            let by_clock_us = (ts - f0) / 10;
            let mut by_samples_us = (samples as i64) * 1_000_000 / 48_000;
            let gap_us = by_clock_us - by_samples_us;
            if info.flags.data_discontinuity || gap_us.abs() > 2_000 {
                println!("mic: packet at {:.3}s discontinuity={} clock-vs-samples {} us", (ts - t0_hns) as f64 / 1e7, info.flags.data_discontinuity, gap_us);
            }
            if gap_us > 5_000 {
                // samples were lost: pad silence so later audio stays on the clock
                let pad = (gap_us * 48_000 / 1_000_000) as u64;
                w.write_all(&vec![0u8; pad as usize * 2])?;
                samples += pad;
                stats.mic_padded_us.fetch_add(gap_us as u64, Ordering::Relaxed);
                by_samples_us = (samples as i64) * 1_000_000 / 48_000;
            }
            let drift = by_clock_us - by_samples_us;
            stats.mic_max_drift_us.fetch_max(drift.unsigned_abs(), Ordering::Relaxed);
            stats.mic_last_drift_us.store(drift, Ordering::Relaxed);
            samples += got;
            stats.mic_frames.store(samples, Ordering::Relaxed);
            let (a, b) = q.as_slices();
            w.write_all(a)?;
            w.write_all(b)?;
            q.clear();
        }
    }
    client.stop_stream()?;
    *first_out.lock().unwrap() = first;
    let mut file = w.into_inner().map_err(|e| e.to_string())?;
    let data = (samples * 2) as u32;
    file.seek(SeekFrom::Start(0))?;
    write_wav_header(&mut file, data)?;
    Ok(name)
}

// ---------- input events (one thread: hook + timer, so lines come out in time order) ----------

struct EvState {
    out: BufWriter<File>,
    t0_hns: i64,
    origin: (i32, i32),
    frame_us: i64,
    last_bucket: i64,
    last_emitted: Option<(i32, i32)>,
    latest: Option<(i32, i32)>,
    stats: Arc<Stats>,
}
static EV: Mutex<Option<EvState>> = Mutex::new(None);

fn t_us(st: &EvState) -> i64 {
    (qpc_hns() - st.t0_hns) / 10
}

fn emit_cursor(st: &mut EvState, x: i32, y: i32, force: bool) {
    let t = t_us(st);
    let bucket = t / st.frame_us;
    if !force && bucket == st.last_bucket {
        return;
    }
    if st.last_emitted == Some((x, y)) {
        return;
    }
    st.last_bucket = bucket;
    st.last_emitted = Some((x, y));
    let _ = writeln!(st.out, r#"{{"tUs":{t},"type":"cursor","x":{x},"y":{y}}}"#);
    st.stats.events_written.fetch_add(1, Ordering::Relaxed);
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let m = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if let Some(st) = EV.lock().unwrap().as_mut() {
            let (x, y) = (m.pt.x - st.origin.0, m.pt.y - st.origin.1);
            let click = match wparam.0 as u32 {
                WM_LBUTTONDOWN => Some(("left", "down")),
                WM_LBUTTONUP => Some(("left", "up")),
                WM_RBUTTONDOWN => Some(("right", "down")),
                WM_RBUTTONUP => Some(("right", "up")),
                WM_MBUTTONDOWN => Some(("middle", "down")),
                WM_MBUTTONUP => Some(("middle", "up")),
                _ => None,
            };
            st.latest = Some((x, y));
            if let Some((b, s)) = click {
                emit_cursor(st, x, y, true); // cursor sits where the click is
                let t = t_us(st);
                let _ = writeln!(st.out, r#"{{"tUs":{t},"type":"click","button":"{b}","state":"{s}","x":{x},"y":{y}}}"#);
                st.stats.events_written.fetch_add(1, Ordering::Relaxed);
            } else {
                emit_cursor(st, x, y, false);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn events_thread(tid_out: mpsc::Sender<u32>, test_window: bool) {
    unsafe {
        tid_out.send(GetCurrentThreadId()).unwrap();
        let hinst = GetModuleHandleW(None).unwrap();
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(hinst.into()), 0).expect("mouse hook");
        // flush the last position of a frame slot even when the mouse stops
        SetTimer(None, 0, 16, None);
        let mut hwnd: Option<HWND> = None;
        if test_window {
            let class = w!("MarzSpikeExcluded");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(def_window_proc),
                hInstance: hinst.into(),
                lpszClassName: class,
                hbrBackground: GetSysColorBrush(COLOR_HIGHLIGHT),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let h = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                class,
                w!("excluded"),
                WS_POPUP | WS_VISIBLE,
                100,
                100,
                400,
                300,
                None,
                None,
                Some(hinst.into()),
                None,
            )
            .expect("test window");
            match SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) {
                Ok(()) => println!("test window: excluded from capture at (100,100) 400x300"),
                Err(e) => println!("test window: SetWindowDisplayAffinity failed: {e}"),
            }
            hwnd = Some(h);
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                // poll too: SetCursorPos and remote tools move the cursor without any hook event
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                if let Some(st) = EV.lock().unwrap().as_mut() {
                    let (x, y) = (p.x - st.origin.0, p.y - st.origin.1);
                    st.latest = Some((x, y));
                    emit_cursor(st, x, y, false);
                }
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
        if let Some(h) = hwnd {
            let _ = DestroyWindow(h);
        }
    }
}

unsafe extern "system" fn def_window_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(h, m, w, l) }
}

// ---------- CPU ----------

fn cpu_time_s(h: HANDLE) -> f64 {
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).unwrap() };
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 1e7;
    ft(k) + ft(u)
}

// ---------- main ----------

fn now_iso() -> String {
    // UTC from SystemTime without a date crate
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn pseudo_uuid() -> String {
    let a = qpc_raw() as u128 ^ ((std::process::id() as u128) << 64);
    let h = format!("{:032x}", a.wrapping_mul(0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835));
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    let out = std::path::PathBuf::from(args.get(1).ok_or("usage: marz-capture <out.marz> [--secs N] [--fps N] [--encoder E] [--no-test-window]")?);
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let secs: u64 = opt("--secs").map(|s| s.parse().unwrap()).unwrap_or(20);
    let fps: u32 = opt("--fps").map(|s| s.parse().unwrap()).unwrap_or(60);
    let test_window = !args.iter().any(|a| a == "--no-test-window");

    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)? };
    fs::create_dir_all(&out)?;

    let monitor = Monitor::primary()?;
    let (w, h) = (monitor.width()?, monitor.height()?);
    let origin = unsafe {
        let hm = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(hm, &mut mi);
        (mi.rcMonitor.left, mi.rcMonitor.top)
    };
    println!("monitor: {} {w}x{h} @ {} Hz, origin {:?}", monitor.name().unwrap_or_default(), monitor.refresh_rate().unwrap_or(0), origin);

    let enc = pick_encoder(opt("--encoder"));
    println!("encoder: {enc}");
    let mut ff = spawn_ffmpeg(&enc, w, h, fps, &out.join("screen.mp4"))?;
    let stdin = ff.stdin.take().unwrap();

    let stats = Arc::new(Stats::default());
    let started_at = now_iso();

    // events thread (hook needs a message loop); test window lives there too
    let (tid_tx, tid_rx) = mpsc::channel();
    let ev_thread = thread::spawn(move || events_thread(tid_tx, test_window));
    let ev_tid = tid_rx.recv()?;
    thread::sleep(Duration::from_millis(300)); // let the test window map before capture starts

    // mic and screen start first and warm up; t0 is set once both deliver
    let stop = Arc::new(AtomicBool::new(false));
    let mic_first = Arc::new(Mutex::new(None));
    let warm_start = qpc_hns();
    let mic = {
        let (p, s, st, mf) = (out.join("mic.wav"), stop.clone(), stats.clone(), mic_first.clone());
        thread::spawn(move || mic_thread(p, s, st, mf))
    };
    let (tx, rx) = mpsc::sync_channel::<(u64, Vec<u8>)>(6);
    let end_idx = Arc::new(AtomicU64::new(0));
    let writer = {
        let (e, s) = (end_idx.clone(), stats.clone());
        thread::spawn(move || video_writer(rx, stdin, e, s))
    };
    let first_ts = Arc::new(Mutex::new(None));
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        match opt("--min-interval-us").map(|v| v.parse::<u64>().unwrap()) {
            Some(0) => MinimumUpdateIntervalSettings::Default,
            // half a frame: the OS default (~16.7 ms) snaps to every 3rd refresh on a 165 Hz screen = 55 fps
            None => MinimumUpdateIntervalSettings::Custom(Duration::from_micros(500_000 / fps as u64)),
            Some(us) => MinimumUpdateIntervalSettings::Custom(Duration::from_micros(us)),
        },
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        ScreenFlags { fps, tx, first_ts: first_ts.clone(), stats: stats.clone() },
    );
    let control = Screen::start_free_threaded(settings).map_err(|e| format!("capture start: {e:?}"))?;
    let mut waited = 0;
    while !(MIC_WARM.load(Ordering::SeqCst) && SCREEN_WARM.load(Ordering::SeqCst)) && waited < 3000 {
        thread::sleep(Duration::from_millis(5));
        waited += 5;
    }
    println!(
        "warm-up: {:.0} ms (mic {}, screen {})",
        (qpc_hns() - warm_start) as f64 / 1e4,
        MIC_WARM.load(Ordering::SeqCst),
        SCREEN_WARM.load(Ordering::SeqCst)
    );

    // t0: recording start on the QPC clock
    let t0 = qpc_hns();
    T0.store(t0, Ordering::SeqCst);
    {
        let mut f = BufWriter::new(File::create(out.join("events.jsonl"))?);
        writeln!(f, r#"{{"type":"header","version":1,"source":{{"width":{w},"height":{h},"fps":{fps}}},"startedAt":"{started_at}"}}"#)?;
        *EV.lock().unwrap() = Some(EvState {
            out: f,
            t0_hns: t0,
            origin,
            frame_us: 1_000_000 / fps as i64,
            last_bucket: -1,
            last_emitted: None,
            latest: None,
            stats: stats.clone(),
        });
    }

    // progress
    let cpu0 = cpu_time_s(unsafe { GetCurrentProcess() });
    let ff_handle = HANDLE(ff.as_raw_handle());
    let ffcpu0 = cpu_time_s(ff_handle);
    for s in 1..=secs {
        thread::sleep(Duration::from_secs(1));
        if s % 10 == 0 || s == secs {
            println!(
                "{s:>4}s  wgc {}  written {}  dup {}  dropped {}  mic {:.2}s  drift max {} us",
                stats.wgc_frames.load(Ordering::Relaxed),
                stats.written_frames.load(Ordering::Relaxed),
                stats.dup_frames.load(Ordering::Relaxed),
                stats.wgc_dropped_full.load(Ordering::Relaxed),
                stats.mic_frames.load(Ordering::Relaxed) as f64 / 48_000.0,
                stats.mic_max_drift_us.load(Ordering::Relaxed),
            );
        }
    }

    // stop
    let t_stop = qpc_hns();
    let cpu1 = cpu_time_s(unsafe { GetCurrentProcess() });
    let ffcpu1 = cpu_time_s(ff_handle);
    let duration_us = (t_stop - t0) / 10;
    let screen_first = first_ts.lock().unwrap().unwrap_or(t0).max(t0);
    let screen_offset_us = (screen_first - t0) / 10;
    let end = ((t_stop - screen_first) as f64 / (10_000_000f64 / fps as f64)).round() as u64;
    end_idx.store(end, Ordering::SeqCst);
    control.stop().map_err(|e| format!("capture stop: {e:?}"))?;
    stop.store(true, Ordering::SeqCst);
    writer.join().unwrap();
    let mic_name = mic.join().unwrap()?;
    unsafe { PostThreadMessageW(ev_tid, WM_QUIT, WPARAM(0), LPARAM(0))? };
    ev_thread.join().unwrap();
    if let Some(mut st) = EV.lock().unwrap().take() {
        st.out.flush()?;
    }
    let ff_status = ff.wait()?;
    let ffcpu_total = cpu_time_s(ff_handle);

    let mic_offset_us = mic_first.lock().unwrap().map(|f| (f - t0) / 10).unwrap_or(0);
    let name = out.file_stem().unwrap().to_string_lossy().to_string();
    let project = format!(
        r#"{{
  "version": 1,
  "id": "{id}",
  "name": "{name}",
  "createdAt": "{started_at}",
  "durationUs": {duration_us},
  "source": {{ "width": {w}, "height": {h}, "fps": {fps} }},
  "tracks": {{
    "screen": {{ "file": "screen.mp4", "offsetUs": {screen_offset_us} }},
    "mic": {{ "file": "mic.wav", "offsetUs": {mic_offset_us}, "volume": 1, "muted": false }}
  }},
  "output": {{ "width": 1920, "height": 1080, "fps": {fps} }},
  "zoomPresets": [],
  "edits": {{ "zooms": [], "cuts": [], "cursor": {{ "hidden": false }}, "clicks": {{ "effect": "none" }} }}
}}
"#,
        id = pseudo_uuid()
    );
    fs::write(out.join("project.json"), project)?;

    let s = &stats;
    let wgc = s.wgc_frames.load(Ordering::Relaxed);
    let wall = (t_stop - t0) as f64 / 1e7;
    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let size = |f: &str| fs::metadata(out.join(f)).map(|m| m.len()).unwrap_or(0);
    let report = format!(
        "REPORT\n\
         duration_s: {wall:.3}\n\
         monitor: {w}x{h}, target fps {fps}, encoder {enc}, ffmpeg exit {ff_status}\n\
         mic device: {mic_name}\n\
         wgc frames: {wgc} ({:.2}/s)  merged(>fps): {}  dropped(queue full): {}\n\
         wgc max gap between frames: {:.1} ms\n\
         gpu->cpu copy per frame: avg {:.2} ms, callback max {:.2} ms\n\
         wgc frame latency (QPC now - SystemRelativeTime): avg {:.2} ms, max {:.2} ms\n\
         written frames: {} (expected {}), of which duplicates: {}\n\
         screen offsetUs: {screen_offset_us}  mic offsetUs: {mic_offset_us}\n\
         mic samples: {} = {:.3}s  discontinuities: {}  silent packets: {}\n\
         mic drift (device QPC position vs sample count) after padding: max {} us, at end {} us, silence padded {} us\n\
         events written: {}\n\
         cpu spike process: {:.1}% of one core ({:.2}% of {} cores)\n\
         cpu ffmpeg: {:.1}% of one core during capture; {:.1} s total incl. flush\n\
         sizes: screen.mp4 {:.2} MB ({:.2} Mbit/s), mic.wav {:.2} MB, events.jsonl {:.1} KB\n",
        wgc as f64 / wall,
        s.wgc_merged.load(Ordering::Relaxed),
        s.wgc_dropped_full.load(Ordering::Relaxed),
        s.max_gap_hns.load(Ordering::Relaxed) as f64 / 1e4,
        s.copy_sum_hns.load(Ordering::Relaxed) as f64 / s.copies.load(Ordering::Relaxed).max(1) as f64 / 1e4,
        s.cb_max_hns.load(Ordering::Relaxed) as f64 / 1e4,
        if wgc > 0 { s.latency_sum_hns.load(Ordering::Relaxed) as f64 / wgc as f64 / 1e4 } else { 0.0 },
        s.latency_max_hns.load(Ordering::Relaxed) as f64 / 1e4,
        s.written_frames.load(Ordering::Relaxed),
        end,
        s.dup_frames.load(Ordering::Relaxed),
        s.mic_frames.load(Ordering::Relaxed),
        s.mic_frames.load(Ordering::Relaxed) as f64 / 48_000.0,
        s.mic_discontinuities.load(Ordering::Relaxed),
        s.mic_silent_flags.load(Ordering::Relaxed),
        s.mic_max_drift_us.load(Ordering::Relaxed),
        s.mic_last_drift_us.load(Ordering::Relaxed),
        s.mic_padded_us.load(Ordering::Relaxed),
        s.events_written.load(Ordering::Relaxed),
        (cpu1 - cpu0) / wall * 100.0,
        (cpu1 - cpu0) / wall * 100.0 / cores,
        cores,
        (ffcpu1 - ffcpu0) / wall * 100.0,
        ffcpu_total,
        size("screen.mp4") as f64 / 1e6,
        size("screen.mp4") as f64 * 8.0 / 1e6 / wall,
        size("mic.wav") as f64 / 1e6,
        size("events.jsonl") as f64 / 1e3,
    );
    print!("{report}");
    fs::write(out.join("spike-report.txt"), report)?;
    Ok(())
}
