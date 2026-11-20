//! Input thread: one message loop runs the low-level mouse hook, a 16 ms `GetCursorPos` poll
//! (catches `SetCursorPos` and remote-tool moves that raise no hook event) and the recorder
//! hotkeys, so every line reaches `events.jsonl` in time order. With `log_keys` on it also runs a
//! low-level keyboard hook: the hook only names and queues a press (privacy rules in `crate::keys`),
//! the loop then checks the focused field is not a password field and writes the `key` line with
//! the press time taken in the hook (`key` lines can sit a few ms after later cursor lines).

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, MapVirtualKeyExW, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MAPVK_VK_TO_CHAR,
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetMessageW,
    GetWindowLongW, GetWindowThreadProcessId, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, ES_PASSWORD, GUITHREADINFO, GWL_STYLE, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use super::cursor::ShapeReader;
use super::qpc::qpc_hns;
use super::{rec_hns, set_dpi_awareness, SharedClock, Warnings};
use crate::events::{Button, EventLog};
use crate::keys::{combo_to_log, is_recorder_hotkey, Mods};
use crate::CaptureError;

/// Cursor poll period.
const POLL_MS: u32 = 16;
/// Thread message: wParam 1 registers the hotkeys, 0 unregisters them.
const WM_SET_HOTKEYS: u32 = WM_APP + 1;
/// Thread message posted by the keyboard hook: key presses wait in `KEY_QUEUE`.
const WM_KEYS_QUEUED: u32 = WM_APP + 2;

/// Recorder hotkeys. `Preset(n)` is 1..=9 (Ctrl+1 .. Ctrl+9), the n-th zoom preset. The comments
/// name the default combos; Settings can rebind each one (`crate::hotkeys`).
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
    /// Ctrl+Shift+1 .. Ctrl+Shift+5: camera layout n (`events::LAYOUTS[n - 1]`).
    Layout(u8),
    /// Ctrl+Shift+D: enter or leave draw mode.
    Draw,
    /// Ctrl+Shift+K: tick the next open checklist topic.
    Check,
    /// Ctrl+Shift+H: hide or show the cursor in the video (logged, the real cursor stays).
    HideCursor,
}

impl Hotkey {
    /// Every hotkey, in registration order.
    pub fn all() -> Vec<Hotkey> {
        let mut v = vec![Hotkey::RecordStop, Hotkey::Pause, Hotkey::Mute];
        v.extend((1..=9).map(Hotkey::Preset));
        v.push(Hotkey::ZoomOut);
        v.extend((1..=5).map(Hotkey::Layout));
        v.push(Hotkey::Draw);
        v.push(Hotkey::Check);
        v.push(Hotkey::HideCursor);
        v
    }

    /// The name shown to people, e.g. "Ctrl+Shift+R", "Ctrl+1" (the combo in force, see `hotkeys`).
    pub fn label(self) -> String {
        crate::hotkeys::combo_for(&self.action()).to_string()
    }

    /// The action id used by Settings (`hotkeys::ACTIONS`): "recordStop", "preset3", "layout2".
    pub fn action(self) -> String {
        match self {
            Hotkey::RecordStop => "recordStop".into(),
            Hotkey::Pause => "pause".into(),
            Hotkey::Mute => "mute".into(),
            Hotkey::Preset(n) => format!("preset{n}"),
            Hotkey::ZoomOut => "zoomOut".into(),
            Hotkey::Layout(n) => format!("layout{n}"),
            Hotkey::Draw => "draw".into(),
            Hotkey::Check => "check".into(),
            Hotkey::HideCursor => "hideCursor".into(),
        }
    }

    fn id(self) -> i32 {
        match self {
            Hotkey::RecordStop => 1,
            Hotkey::Pause => 2,
            Hotkey::Mute => 3,
            Hotkey::Preset(n) => 3 + i32::from(n),
            Hotkey::ZoomOut => 13,
            // 14..=17 for the first four (older builds), 20 for the fifth (18 and 19 are taken).
            Hotkey::Layout(5) => 20,
            Hotkey::Layout(n) => 13 + i32::from(n),
            Hotkey::Draw => 18,
            Hotkey::Check => 19,
            Hotkey::HideCursor => 21,
        }
    }

    fn from_id(id: i32) -> Option<Hotkey> {
        Hotkey::all().into_iter().find(|h| h.id() == id)
    }

    fn keys(self) -> (HOT_KEY_MODIFIERS, u32) {
        let c = crate::hotkeys::combo_for(&self.action());
        let mut mods = MOD_NOREPEAT;
        for (on, m) in [(c.ctrl, MOD_CONTROL), (c.alt, MOD_ALT), (c.shift, MOD_SHIFT)] {
            if on {
                mods |= m;
            }
        }
        (mods, c.vk())
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
    /// Write `key` lines (keyboard hook installed). Off: no keyboard hook at all.
    pub log_keys: bool,
}

impl InputShared {
    /// Without key logging (no keyboard hook).
    pub fn new(clock: SharedClock, hotkeys: mpsc::Sender<Hotkey>, warn: Warnings) -> Arc<Self> {
        Self::with_keys(clock, hotkeys, warn, false)
    }

    /// `log_keys` installs the keyboard hook and writes `key` lines (privacy rules in `crate::keys`).
    pub fn with_keys(clock: SharedClock, hotkeys: mpsc::Sender<Hotkey>, warn: Warnings, log_keys: bool) -> Arc<Self> {
        Arc::new(Self { clock, log: Mutex::new(None), hotkeys, warn, log_keys })
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

    /// Like `with_log` with a time taken earlier (a key press time from the hook).
    fn with_log_at(&self, rec_us: i64, f: impl FnOnce(&mut EventLog<BufWriter<File>>, i64)) {
        if let Ok(mut g) = self.log.lock()
            && let Some(log) = g.as_mut()
        {
            f(log, rec_us);
        }
    }
}

// Generic codes too: keys sent with SendInput can arrive as VK_SHIFT, VK_CONTROL or VK_MENU.
const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const MODIFIERS: [u32; 11] = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN];

/// Keys held right now, from the keyboard hook's own down and up stream (left/right specific codes).
struct HeldKeys([bool; 256]);

impl HeldKeys {
    fn any(&self, vks: &[u32]) -> bool {
        vks.iter().any(|&v| self.0[v as usize])
    }

    fn mods(&self) -> Mods {
        Mods {
            ctrl: self.any(&[VK_CONTROL, VK_LCONTROL, VK_RCONTROL]),
            alt: self.any(&[VK_MENU, VK_LMENU, VK_RMENU]),
            shift: self.any(&[VK_SHIFT, VK_LSHIFT, VK_RSHIFT]),
            win: self.any(&[VK_LWIN, VK_RWIN]),
            altgr: self.0[VK_RMENU as usize],
        }
    }

    /// Forget modifiers Windows no longer reports as held (a key up the hook never saw, e.g. after
    /// Ctrl+Alt+Delete or Win+L). A stuck Ctrl would turn typing into "shortcuts", so this errs
    /// toward fewer modifiers.
    fn drop_stale_modifiers(&mut self) {
        for vk in MODIFIERS {
            if self.0[vk as usize] && (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 == 0 {
                self.0[vk as usize] = false;
            }
        }
    }
}

thread_local! {
    /// The hook procedure has no user pointer; it runs on the input thread, so a thread-local works.
    static CTX: RefCell<Option<Arc<InputShared>>> = const { RefCell::new(None) };
    static HELD: RefCell<HeldKeys> = const { RefCell::new(HeldKeys([false; 256])) };
    /// Presses the keyboard hook let through: (recording time, keys), written by the loop.
    static KEY_QUEUE: RefCell<VecDeque<(i64, Vec<String>)>> = const { RefCell::new(VecDeque::new()) };
    static INPUT_TID: Cell<u32> = const { Cell::new(0) };
}

/// What an OEM symbol key types without Shift on the foreground window's keyboard layout.
fn key_symbol(vk: u32) -> Option<char> {
    unsafe {
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let hkl = GetKeyboardLayout(tid);
        let v = MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR, Some(hkl)) & 0xFFFF; // the top bit marks dead keys
        if v == 0 { None } else { char::from_u32(v) }
    }
}

/// Kept fast: track held keys, drop repeats and what the rules forbid, queue the rest with the
/// press time and wake the loop. Injected keys (SendInput) are treated like real ones.
unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let vk = k.vkCode & 0xFF;
        let msg = wparam.0 as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        let press = HELD.with(|h| {
            let mut h = h.borrow_mut();
            if up {
                h.0[vk as usize] = false;
                return None;
            }
            if !down || h.0[vk as usize] {
                return None; // auto-repeat: the key is already down
            }
            h.0[vk as usize] = true;
            if MODIFIERS.contains(&vk) {
                return None;
            }
            h.drop_stale_modifiers();
            Some(h.mods())
        });
        if let Some(mods) = press
            && !is_recorder_hotkey(mods, vk)
            && let Some(keys) = combo_to_log(mods, vk, key_symbol(vk))
        {
            let t = CTX.with(|c| c.borrow().as_ref().and_then(|sh| sh.rec_us_now()));
            if let Some(t) = t {
                KEY_QUEUE.with(|q| q.borrow_mut().push_back((t, keys)));
                let tid = INPUT_TID.with(Cell::get);
                let _ = unsafe { PostThreadMessageW(tid, WM_KEYS_QUEUED, WPARAM(0), LPARAM(0)) };
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// True unless the focused field is known not to be a password field. Fails closed: any error, or
/// no UI Automation, counts as a password field.
fn focus_may_be_password(uia: Option<&IUIAutomation>) -> bool {
    unsafe {
        // Classic edit box with the password style (GetGUIThreadInfo(0): the foreground thread).
        let mut gui = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if GetGUIThreadInfo(0, &mut gui).is_err() {
            return true;
        }
        if gui.hwndFocus != HWND::default() {
            let style = GetWindowLongW(gui.hwndFocus, GWL_STYLE);
            let mut buf = [0u16; 128];
            let n = GetClassNameW(gui.hwndFocus, &mut buf).max(0) as usize;
            let class = String::from_utf16_lossy(&buf[..n]).to_ascii_lowercase();
            if style & ES_PASSWORD != 0 && class.contains("edit") {
                return true;
            }
        }
        // UI Automation: browsers and modern apps.
        let Some(uia) = uia else { return true };
        match uia.GetFocusedElement().and_then(|e| e.CurrentIsPassword()) {
            Ok(is_password) => is_password.as_bool(),
            Err(_) => true,
        }
    }
}

/// Write the queued presses unless a password field has the focus.
fn write_queued_keys(sh: &InputShared, uia: Option<&IUIAutomation>) {
    // Take the queue first: the UI Automation call below pumps messages, so the hook can run again.
    let queued = KEY_QUEUE.with(|q| std::mem::take(&mut *q.borrow_mut()));
    if queued.is_empty() || focus_may_be_password(uia) {
        return;
    }
    for (t, keys) in queued {
        let names: Vec<&str> = keys.iter().map(String::as_str).collect();
        sh.with_log_at(t, |log, t| log.key(t, &names));
    }
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
        INPUT_TID.with(|t| t.set(GetCurrentThreadId()));
        // Keyboard hook and UI Automation only when key logging is on.
        let mut com = false;
        let mut uia: Option<IUIAutomation> = None;
        let mut kb_hook: Option<HHOOK> = None;
        if sh.log_keys {
            com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            uia = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok();
            if uia.is_none() {
                let _ = sh.warn.send("Shortcuts are not logged: the password field check is not available.".to_string());
            }
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(hinst.into()), 0) {
                Ok(h) => kb_hook = Some(h),
                Err(_) => {
                    let _ = sh.warn.send("Shortcuts are not logged: the keyboard hook failed.".to_string());
                }
            }
        }
        let timer = SetTimer(None, 0, POLL_MS, None);
        let mut shapes = ShapeReader::new();
        let mut registered = Vec::new();
        let _ = ready.send(Ok(GetCurrentThreadId()));
        set_hotkeys(hotkeys_on, &mut registered, &sh);

        // GetMessageW returns -1 on error: loop only while it is > 0, or an error would busy-loop.
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            match msg.message {
                WM_TIMER => {
                    let mut p = POINT::default();
                    let shape = shapes.read();
                    if GetCursorPos(&mut p).is_ok() {
                        sh.with_log(|log, t| {
                            if let Some((name, px)) = shape {
                                log.cursor_shape(t, name, px);
                            }
                            log.cursor(t, p.x, p.y);
                        });
                    }
                }
                WM_HOTKEY => {
                    if let Some(h) = Hotkey::from_id(msg.wParam.0 as i32) {
                        let _ = sh.hotkeys.send(h);
                    }
                }
                WM_SET_HOTKEYS => set_hotkeys(msg.wParam.0 != 0, &mut registered, &sh),
                WM_KEYS_QUEUED => write_queued_keys(&sh, uia.as_ref()),
                _ => {}
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        set_hotkeys(false, &mut registered, &sh);
        let _ = KillTimer(None, timer);
        let _ = UnhookWindowsHookEx(hook);
        if let Some(h) = kb_hook {
            let _ = UnhookWindowsHookEx(h);
        }
        KEY_QUEUE.with(|q| q.borrow_mut().clear());
        HELD.with(|h| h.borrow_mut().0 = [false; 256]);
        drop(uia);
        if com {
            CoUninitialize();
        }
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

#[cfg(test)]
mod tests {
    use super::Hotkey;

    #[test]
    fn hotkey_ids_are_unique_and_round_trip() {
        let all = Hotkey::all();
        let mut ids: Vec<i32> = all.iter().map(|h| h.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), all.len());
        for h in all {
            assert_eq!(Hotkey::from_id(h.id()), Some(h));
        }
        assert_eq!(Hotkey::Layout(5).label(), "Ctrl+Shift+5");
        assert_eq!(Hotkey::HideCursor.label(), "Ctrl+Shift+H");
    }
}
