//! Input thread: one message loop runs the low-level mouse hook, a 16 ms `GetCursorPos` poll
//! (catches `SetCursorPos` and remote-tool moves that raise no hook event) and the recorder
//! hotkeys, so every line reaches `events.jsonl` in time order.

use std::cell::RefCell;
use std::fs::File;
use std::io::BufWriter;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WH_MOUSE_LL, WM_APP,
    WM_HOTKEY, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_TIMER,
};

use super::qpc::qpc_hns;
use super::{rec_hns, set_dpi_awareness, SharedClock, Warnings};
use crate::events::{Button, EventLog};
use crate::CaptureError;

/// Cursor poll period.
const POLL_MS: u32 = 16;
/// Thread message: wParam 1 registers the hotkeys, 0 unregisters them.
const WM_SET_HOTKEYS: u32 = WM_APP + 1;

/// Recorder hotkeys. `Preset(n)` is 1..=9 (Ctrl+1 .. Ctrl+9), the n-th zoom preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hotkey {
    /// Ctrl+Shift+R
    RecordStop,
    /// Ctrl+Shift+P
    Pause,
    /// Ctrl+Shift+M
    Mute,
    /// Ctrl+1 .. Ctrl+9
    Preset(u8),
    /// Ctrl+0
    ZoomOut,
    /// Ctrl+Shift+1 .. Ctrl+Shift+4: camera layout n (`events::LAYOUTS[n - 1]`).
    Layout(u8),
}

impl Hotkey {
    /// Every hotkey, in registration order.
    pub fn all() -> Vec<Hotkey> {
        let mut v = vec![Hotkey::RecordStop, Hotkey::Pause, Hotkey::Mute];
        v.extend((1..=9).map(Hotkey::Preset));
        v.push(Hotkey::ZoomOut);
        v.extend((1..=4).map(Hotkey::Layout));
        v
    }

    /// The name shown to people, e.g. "Ctrl+Shift+R", "Ctrl+1".
    pub fn label(self) -> String {
        match self {
            Hotkey::RecordStop => "Ctrl+Shift+R".into(),
            Hotkey::Pause => "Ctrl+Shift+P".into(),
            Hotkey::Mute => "Ctrl+Shift+M".into(),
            Hotkey::Preset(n) => format!("Ctrl+{n}"),
            Hotkey::ZoomOut => "Ctrl+0".into(),
            Hotkey::Layout(n) => format!("Ctrl+Shift+{n}"),
        }
    }

    fn id(self) -> i32 {
        match self {
            Hotkey::RecordStop => 1,
            Hotkey::Pause => 2,
            Hotkey::Mute => 3,
            Hotkey::Preset(n) => 3 + i32::from(n),
            Hotkey::ZoomOut => 13,
            Hotkey::Layout(n) => 13 + i32::from(n),
        }
    }

    fn from_id(id: i32) -> Option<Hotkey> {
        Hotkey::all().into_iter().find(|h| h.id() == id)
    }

    fn keys(self) -> (HOT_KEY_MODIFIERS, u32) {
        let ctrl_shift = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
        let ctrl = MOD_CONTROL | MOD_NOREPEAT;
        match self {
            Hotkey::RecordStop => (ctrl_shift, u32::from(b'R')),
            Hotkey::Pause => (ctrl_shift, u32::from(b'P')),
            Hotkey::Mute => (ctrl_shift, u32::from(b'M')),
            Hotkey::Preset(n) => (ctrl, u32::from(b'0' + n)),
            Hotkey::ZoomOut => (ctrl, u32::from(b'0')),
            Hotkey::Layout(n) => (ctrl_shift, u32::from(b'0' + n)),
        }
    }
}

/// Shared between the session and the input thread. See the `win` module docs.
pub struct InputShared {
    pub clock: SharedClock,
    /// The events log; `None` until the session writes the header at t0. The session writes
    /// `pause`, `resume` and `zoom` lines through this same mutex (take the clock first, release it).
    pub log: Mutex<Option<EventLog<BufWriter<File>>>>,
    /// Fired hotkeys.
    pub hotkeys: mpsc::Sender<Hotkey>,
    pub warn: Warnings,
}

impl InputShared {
    pub fn new(clock: SharedClock, hotkeys: mpsc::Sender<Hotkey>, warn: Warnings) -> Arc<Self> {
        Arc::new(Self { clock, log: Mutex::new(None), hotkeys, warn })
    }

    /// Recording time in microseconds now, or None (before t0, paused).
    fn rec_us_now(&self) -> Option<i64> {
        rec_hns(&self.clock, qpc_hns()).map(|h| h / 10)
    }

    fn with_log(&self, f: impl FnOnce(&mut EventLog<BufWriter<File>>, i64)) {
        let Some(rec_us) = self.rec_us_now() else { return };
        if let Ok(mut g) = self.log.lock()
            && let Some(log) = g.as_mut()
        {
            f(log, rec_us);
        }
    }
}

thread_local! {
    /// The hook procedure has no user pointer; it runs on the input thread, so a thread-local works.
    static CTX: RefCell<Option<Arc<InputShared>>> = const { RefCell::new(None) };
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let m = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let (x, y) = (m.pt.x, m.pt.y);
        let click = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some((Button::Left, true)),
            WM_LBUTTONUP => Some((Button::Left, false)),
            WM_RBUTTONDOWN => Some((Button::Right, true)),
            WM_RBUTTONUP => Some((Button::Right, false)),
            WM_MBUTTONDOWN => Some((Button::Middle, true)),
            WM_MBUTTONUP => Some((Button::Middle, false)),
            _ => None, // moves, wheel, X buttons
        };
        CTX.with(|c| {
            if let Some(sh) = c.borrow().as_ref() {
                sh.with_log(|log, t| {
                    log.cursor(t, x, y); // the cursor sits where the click is
                    if let Some((b, down)) = click {
                        log.click(t, b, down, x, y);
                    }
                });
            }
        });
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn set_hotkeys(on: bool, registered: &mut Vec<i32>, sh: &InputShared) {
    if on {
        for h in Hotkey::all() {
            if registered.contains(&h.id()) {
                continue;
            }
            let (mods, vk) = h.keys();
            match unsafe { RegisterHotKey(None, h.id(), mods, vk) } {
                Ok(()) => registered.push(h.id()),
                Err(_) => {
                    let _ = sh.warn.send(format!("Hotkey {} is taken by another app", h.label()));
                }
            }
        }
    } else {
        for id in registered.drain(..) {
            let _ = unsafe { UnregisterHotKey(None, id) };
        }
    }
}

fn input_thread(sh: Arc<InputShared>, hotkeys_on: bool, ready: mpsc::Sender<Result<u32, CaptureError>>) {
    unsafe {
        let mut msg = MSG::default();
        // Create the thread's message queue before anyone posts to it.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(CaptureError::Device(format!("input setup failed: {e}"))));
                return;
            }
        };
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(hinst.into()), 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(CaptureError::Device(format!("mouse hook failed: {e}"))));
                return;
            }
        };
        CTX.with(|c| *c.borrow_mut() = Some(sh.clone()));
        let timer = SetTimer(None, 0, POLL_MS, None);
        let mut registered = Vec::new();
        let _ = ready.send(Ok(GetCurrentThreadId()));
        set_hotkeys(hotkeys_on, &mut registered, &sh);

        // GetMessageW returns -1 on error: loop only while it is > 0, or an error would busy-loop.
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            match msg.message {
                WM_TIMER => {
                    let mut p = POINT::default();
                    if GetCursorPos(&mut p).is_ok() {
                        sh.with_log(|log, t| log.cursor(t, p.x, p.y));
                    }
                }
                WM_HOTKEY => {
                    if let Some(h) = Hotkey::from_id(msg.wParam.0 as i32) {
                        let _ = sh.hotkeys.send(h);
                    }
                }
                WM_SET_HOTKEYS => set_hotkeys(msg.wParam.0 != 0, &mut registered, &sh),
                _ => {}
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        set_hotkeys(false, &mut registered, &sh);
        let _ = KillTimer(None, timer);
        let _ = UnhookWindowsHookEx(hook);
        CTX.with(|c| *c.borrow_mut() = None);
    }
}

pub struct InputHandle {
    tid: u32,
    thread: JoinHandle<()>,
    shared: Arc<InputShared>,
}

/// Start the input thread. Hotkeys are registered now when `hotkeys_on`, and can be switched any
/// time with `set_hotkeys_enabled` (only while a session or the recorder setup is open).
pub fn start(shared: Arc<InputShared>, hotkeys_on: bool) -> Result<InputHandle, CaptureError> {
    set_dpi_awareness(); // physical cursor pixels, matching the WGC frame
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = {
        let sh = shared.clone();
        thread::Builder::new().name("marz-input".into()).spawn(move || input_thread(sh, hotkeys_on, ready_tx))?
    };
    match ready_rx.recv() {
        Ok(Ok(tid)) => Ok(InputHandle { tid, thread, shared }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err(CaptureError::Device("the input thread ended during setup".into()))
        }
    }
}

impl InputHandle {
    /// Register (true) or unregister (false) the recorder hotkeys. Keys another app owns are
    /// reported as warnings "Hotkey Ctrl+1 is taken by another app".
    pub fn set_hotkeys_enabled(&self, on: bool) {
        let _ = unsafe { PostThreadMessageW(self.tid, WM_SET_HOTKEYS, WPARAM(usize::from(on)), LPARAM(0)) };
    }

    /// Stop the thread (hotkeys unregistered, hook removed), then take the events log out of the
    /// shared state and flush it. Returns the first write error the log kept.
    pub fn stop(self) -> Result<(), CaptureError> {
        let _ = unsafe { PostThreadMessageW(self.tid, WM_QUIT, WPARAM(0), LPARAM(0)) };
        self.thread.join().map_err(|_| CaptureError::Device("the input thread panicked".into()))?;
        let log = self.shared.log.lock().ok().and_then(|mut g| g.take());
        if let Some(mut log) = log {
            log.flush()?;
        }
        Ok(())
    }
}
