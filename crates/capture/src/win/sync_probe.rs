//! Sync probe: a black window over one monitor that turns white for 100 ms every 3 s while a
//! 1 kHz, 100 ms beep plays through the default output at the same moment. Record it with
//! `marz-capture record <out> --sync-probe` and read the result with `pnpm sync-check`.
//!
//! The window is a plain top-most popup. It is deliberately not excluded from capture, so the
//! screen track sees the flash. One thread owns the window and runs the schedule: at each tick it
//! stores the QPC time in [`Shared::trigger`] and paints the window white in the same pass. The
//! audio thread (WASAPI shared mode, event driven) notices the trigger on its next wake-up and
//! writes the beep into the render buffer. For every beep it records how long the trigger waited
//! for that write and how many frames were already queued in the buffer; with the stream latency
//! WASAPI reports, those add up to the delay between "flash painted" and "beep leaves the engine".
//! The physical speaker path and the mic input path are not included.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, FillRect, GetStockObject, HBRUSH, HDC, InvalidateRect, UpdateWindow, WHITE_BRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, PM_REMOVE, PeekMessageW, RegisterClassExW, SW_SHOWNOACTIVATE, ShowWindow,
    TranslateMessage, UnregisterClassW, WM_ERASEBKGND, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::w;

use super::qpc::qpc_hns;
use crate::CaptureError;

/// Seconds between flashes.
pub const INTERVAL_S: f64 = 3.0;
/// First flash after the probe starts, so the screen is black before it.
const FIRST_FLASH_S: f64 = 2.0;
/// How long the window stays white.
const FLASH_MS: i64 = 100;
const BEEP_HZ: f32 = 1000.0;
const BEEP_MS: u32 = 100;
const BEEP_AMPLITUDE: f32 = 0.5;
const RATE: u32 = 48_000;
const CHANNELS: usize = 2;
const BYTES_PER_FRAME: usize = CHANNELS * 4;
const HNS_PER_MS: i64 = 10_000;
const HNS_PER_S: i64 = 10_000_000;

/// What the audio thread measured for one beep.
#[derive(Debug, Clone, Copy)]
struct BeepStat {
    /// Trigger (flash painted) to the moment the beep samples were handed to WASAPI.
    trigger_to_write_ms: f64,
    /// Frames already queued in the render buffer at that moment, as milliseconds.
    queued_ms: f64,
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    /// QPC (100 ns) of the last flash whose beep has not been written yet; 0 for none.
    trigger: AtomicI64,
    flashes: AtomicU32,
    beeps: Mutex<Vec<BeepStat>>,
}

/// What the probe found out, written next to the project as `sync-probe.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeReport {
    pub device_name: String,
    pub flashes: u32,
    pub beeps: u32,
    /// `GetStreamLatency` of the render stream.
    pub stream_latency_ms: f64,
    /// Mean time from flash trigger to the beep write.
    pub trigger_to_write_ms: f64,
    /// Mean frames queued in the render buffer at the write.
    pub queued_ms: f64,
    /// `stream_latency_ms + trigger_to_write_ms + queued_ms`: the delay `pnpm sync-check` expects between flash and beep.
    pub render_latency_ms: f64,
}

impl ProbeReport {
    /// The `sync-probe.json` text.
    pub fn to_json(&self) -> String {
        let v = serde_json::json!({
            "version": 1,
            "renderDevice": self.device_name,
            "flashes": self.flashes,
            "beeps": self.beeps,
            "streamLatencyMs": round1(self.stream_latency_ms),
            "triggerToWriteMs": round1(self.trigger_to_write_ms),
            "queuedMs": round1(self.queued_ms),
            "renderLatencyMs": round1(self.render_latency_ms),
        });
        serde_json::to_string_pretty(&v).unwrap_or_default() + "\n"
    }

    /// The lines the CLI prints.
    pub fn text(&self) -> String {
        format!(
            "sync probe: {} flashes, {} beeps on {}\nrender stream latency WASAPI reports: {:.1} ms; plus {:.1} ms trigger to write and {:.1} ms queued = {:.1} ms expected flash-to-beep delay\n",
            self.flashes, self.beeps, self.device_name, self.stream_latency_ms, self.trigger_to_write_ms, self.queued_ms, self.render_latency_ms
        )
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

struct AudioSetup {
    device_name: String,
    stream_latency_ms: f64,
}

/// A running probe. Dropping it closes the window and stops the sound.
pub struct SyncProbe {
    shared: Arc<Shared>,
    window: Option<JoinHandle<()>>,
    audio: Option<JoinHandle<()>>,
    setup: AudioSetup,
}

/// Show the black window on the monitor rectangle and start the audio. Returns once both are
/// running; the first flash comes 2 s later.
pub fn start(origin: (i32, i32), size: (u32, u32)) -> Result<SyncProbe, CaptureError> {
    let shared = Arc::new(Shared::default());

    let (audio_tx, audio_rx) = mpsc::channel::<Result<AudioSetup, CaptureError>>();
    let sh = shared.clone();
    let audio = thread::Builder::new().name("marz-probe-audio".into()).spawn(move || audio_thread(sh, audio_tx))?;
    let audio_setup = match audio_rx.recv() {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = audio.join();
            return Err(e);
        }
        Err(_) => {
            let _ = audio.join();
            return Err(CaptureError::Device("the probe audio thread ended during setup".into()));
        }
    };

    let (win_tx, win_rx) = mpsc::channel::<Result<(), CaptureError>>();
    let sh = shared.clone();
    let window = thread::Builder::new().name("marz-probe-window".into()).spawn(move || window_thread(sh, origin, size, win_tx))?;
    match win_rx.recv() {
        Ok(Ok(())) => {}
        other => {
            shared.stop.store(true, Ordering::SeqCst);
            let _ = window.join();
            let _ = audio.join();
            return Err(match other {
                Ok(Err(e)) => e,
                _ => CaptureError::Device("the probe window thread ended during setup".into()),
            });
        }
    }
    Ok(SyncProbe { shared, window: Some(window), audio: Some(audio), setup: audio_setup })
}

impl SyncProbe {
    /// Stop the schedule, close the window and return what was measured.
    pub fn stop(mut self) -> ProbeReport {
        self.shutdown();
        let beeps = self.shared.beeps.lock().map(|b| b.clone()).unwrap_or_default();
        let n = beeps.len().max(1) as f64;
        let trigger_to_write_ms = beeps.iter().map(|b| b.trigger_to_write_ms).sum::<f64>() / n;
        let queued_ms = beeps.iter().map(|b| b.queued_ms).sum::<f64>() / n;
        ProbeReport {
            device_name: self.setup.device_name.clone(),
            flashes: self.shared.flashes.load(Ordering::SeqCst),
            beeps: beeps.len() as u32,
            stream_latency_ms: self.setup.stream_latency_ms,
            trigger_to_write_ms,
            queued_ms,
            render_latency_ms: self.setup.stream_latency_ms + trigger_to_write_ms + queued_ms,
        }
    }

    fn shutdown(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.window.take() {
            let _ = h.join();
        }
        if let Some(h) = self.audio.take() {
            let _ = h.join();
        }
    }
}

impl Drop for SyncProbe {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---- window ---------------------------------------------------------------------------------

/// True while the window should paint white. Only the window thread writes it.
static LIT: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_ERASEBKGND {
        let mut r = RECT::default();
        let _ = unsafe { GetClientRect(hwnd, &mut r) };
        let stock = unsafe { GetStockObject(if LIT.load(Ordering::SeqCst) { WHITE_BRUSH } else { BLACK_BRUSH }) };
        unsafe { FillRect(HDC(wparam.0 as *mut core::ffi::c_void), &r, HBRUSH(stock.0)) };
        return LRESULT(1);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn paint(hwnd: HWND, lit: bool) {
    LIT.store(lit, Ordering::SeqCst);
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, true);
        let _ = UpdateWindow(hwnd);
    }
}

fn window_thread(shared: Arc<Shared>, origin: (i32, i32), size: (u32, u32), ready: mpsc::Sender<Result<(), CaptureError>>) {
    let class = w!("MarzSyncProbe");
    let setup = || -> Result<(HWND, HINSTANCE), CaptureError> {
        let hinst: HINSTANCE = unsafe { GetModuleHandleW(None) }.map_err(|e| CaptureError::Device(format!("probe window: {e}")))?.into();
        let wc = WNDCLASSEXW { cbSize: size_of::<WNDCLASSEXW>() as u32, lpfnWndProc: Some(wnd_proc), hInstance: hinst, lpszClassName: class, ..Default::default() };
        // A second probe in the same process re-registers the class; that error is harmless.
        unsafe { RegisterClassExW(&wc) };
        LIT.store(false, Ordering::SeqCst);
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class,
                w!("Marz sync probe"),
                WS_POPUP,
                origin.0,
                origin.1,
                size.0 as i32,
                size.1 as i32,
                None,
                None,
                Some(hinst),
                None,
            )
        }
        .map_err(|e| CaptureError::Device(format!("could not open the probe window: {e}")))?;
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        paint(hwnd, false);
        Ok((hwnd, hinst))
    };
    let (hwnd, hinst) = match setup() {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let interval = (INTERVAL_S * HNS_PER_S as f64) as i64;
    let mut next_flash = qpc_hns() + (FIRST_FLASH_S * HNS_PER_S as f64) as i64;
    let mut flash_end: Option<i64> = None;
    let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
    while !shared.stop.load(Ordering::SeqCst) {
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            let _ = unsafe { TranslateMessage(&msg) };
            unsafe { DispatchMessageW(&msg) };
        }
        let now = qpc_hns();
        if now >= next_flash {
            // Tell the audio thread first (one store), then paint: both happen within a millisecond.
            shared.trigger.store(now, Ordering::SeqCst);
            shared.flashes.fetch_add(1, Ordering::SeqCst);
            paint(hwnd, true);
            flash_end = Some(now + FLASH_MS * HNS_PER_MS);
            next_flash += interval;
        }
        if let Some(end) = flash_end
            && now >= end
        {
            paint(hwnd, false);
            flash_end = None;
        }
        thread::sleep(Duration::from_millis(1));
    }
    unsafe {
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(class, Some(hinst));
    }
}

// ---- audio ----------------------------------------------------------------------------------

fn beep_frames() -> Vec<f32> {
    let n = (RATE * BEEP_MS / 1000) as usize;
    (0..n).map(|i| BEEP_AMPLITUDE * (2.0 * std::f32::consts::PI * BEEP_HZ * i as f32 / RATE as f32).sin()).collect()
}

fn audio_thread(shared: Arc<Shared>, ready: mpsc::Sender<Result<AudioSetup, CaptureError>>) {
    let dev_err = |what: &str, e: wasapi::WasapiError| CaptureError::Device(format!("sound output {what}: {e}"));
    let setup = || -> Result<_, CaptureError> {
        let _ = initialize_mta();
        let en = DeviceEnumerator::new().map_err(|e| dev_err("enumeration failed", e))?;
        let dev = en.get_default_device(Direction::Render).map_err(|e| dev_err("not found", e))?;
        let name = dev.get_friendlyname().unwrap_or_default();
        let mut client = dev.get_iaudioclient().map_err(|e| dev_err("could not open", e))?;
        let fmt = WaveFormat::new(32, 32, SampleType::Float, RATE as usize, CHANNELS, None);
        let (default_period, _min) = client.get_device_period().map_err(|e| dev_err("period", e))?;
        client
            .initialize_client(&fmt, Direction::Render, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: default_period }, None)
            .map_err(|e| dev_err("could not start", e))?;
        let ev = client.set_get_eventhandle().map_err(|e| dev_err("event", e))?;
        let render = client.get_audiorenderclient().map_err(|e| dev_err("render client", e))?;
        let latency_hns = client.get_stream_latency().map_err(|e| dev_err("latency", e))?;
        // Fill the buffer with silence before starting, as the WASAPI docs ask.
        let space = client.get_available_space_in_frames().map_err(|e| dev_err("buffer", e))? as usize;
        render.write_to_device(&vec![0u8; space * BYTES_PER_FRAME], None).map_err(|e| dev_err("buffer", e))?;
        client.start_stream().map_err(|e| dev_err("could not start", e))?;
        Ok((name, latency_hns, client, ev, render))
    };
    let (name, latency_hns, client, ev, render) = match setup() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(AudioSetup { device_name: name, stream_latency_ms: latency_hns as f64 / HNS_PER_MS as f64 }));

    let beep = beep_frames();
    let mut beep_pos: Option<usize> = None;
    while !shared.stop.load(Ordering::SeqCst) {
        let _ = ev.wait_for_event(50);
        let Ok(space) = client.get_available_space_in_frames() else { break };
        let space = space as usize;
        if space == 0 {
            continue;
        }
        if beep_pos.is_none() {
            let trig = shared.trigger.load(Ordering::SeqCst);
            if trig != 0 {
                let now = qpc_hns();
                let padding = client.get_current_padding().unwrap_or(0);
                if let Ok(mut v) = shared.beeps.lock() {
                    v.push(BeepStat { trigger_to_write_ms: (now - trig) as f64 / HNS_PER_MS as f64, queued_ms: f64::from(padding) * 1000.0 / f64::from(RATE) });
                }
                shared.trigger.store(0, Ordering::SeqCst);
                beep_pos = Some(0);
            }
        }
        let mut data = vec![0u8; space * BYTES_PER_FRAME];
        if let Some(pos) = beep_pos {
            let n = space.min(beep.len() - pos);
            for (i, frame) in data.as_chunks_mut::<BYTES_PER_FRAME>().0.iter_mut().take(n).enumerate() {
                let s = beep[pos + i].to_le_bytes();
                frame[..4].copy_from_slice(&s);
                frame[4..].copy_from_slice(&s);
            }
            beep_pos = if pos + n >= beep.len() { None } else { Some(pos + n) };
        }
        if render.write_to_device(&data, None).is_err() {
            break;
        }
    }
    let _ = client.stop_stream();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beep_is_100_ms_of_1_khz_at_half_scale() {
        let b = beep_frames();
        assert_eq!(b.len(), 4800);
        assert_eq!(b[0], 0.0);
        let peak = b.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - BEEP_AMPLITUDE).abs() < 0.01, "{peak}");
        // 1 kHz at 48 kHz: 48 samples per cycle, so sample 48 is back at zero.
        assert!(b[48].abs() < 1e-3);
    }

    #[test]
    fn report_json_carries_the_latency_sync_check_reads() {
        let r = ProbeReport {
            device_name: "Speakers".into(),
            flashes: 21,
            beeps: 21,
            stream_latency_ms: 10.04,
            trigger_to_write_ms: 4.26,
            queued_ms: 9.97,
            render_latency_ms: 24.27,
        };
        let v: serde_json::Value = serde_json::from_str(&r.to_json()).unwrap();
        assert_eq!(v["renderLatencyMs"], 24.3);
        assert_eq!(v["streamLatencyMs"], 10.0);
        assert_eq!(v["flashes"], 21);
        assert!(r.text().contains("render stream latency WASAPI reports: 10.0 ms"));
    }
}
