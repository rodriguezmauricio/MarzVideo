//! Closing the main window saves the last edit first. The editor autosaves after a 2 s pause and a
//! page cannot wait for a save in `beforeunload`, so the close is held here: Rust asks the page to
//! save (`app://flush`), the page saves and calls `close_main`. If the page does not answer within
//! 3 s (hung or still loading), the window closes anyway.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

pub const FLUSH_EVENT: &str = "app://flush";
const MAIN: &str = "main";
const FALLBACK: Duration = Duration::from_secs(3);

/// Set once the page was asked to save; a second close click waits for the same answer.
#[derive(Default)]
pub struct Closing(AtomicBool);

impl Closing {
    /// True the first time only: ask the page and start the fallback timer.
    pub fn begin(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

fn destroy_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        // `destroy` skips CloseRequested, so this does not come back here.
        let _ = w.destroy();
    }
}

/// The main window's close button (or Alt+F4): hold the close and ask the page to save.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != MAIN {
        return;
    }
    api.prevent_close();
    if !window.state::<Closing>().begin() {
        return;
    }
    let app = window.app_handle().clone();
    if window.emit_to(MAIN, FLUSH_EVENT, ()).is_err() {
        return destroy_main(&app);
    }
    let spawned = std::thread::Builder::new().name("marz-close-fallback".into()).spawn({
        let app = app.clone();
        move || {
            std::thread::sleep(FALLBACK);
            destroy_main(&app);
        }
    });
    if spawned.is_err() {
        destroy_main(&app);
    }
}

/// The page saved (or tried to): close the main window now.
#[tauri::command]
pub fn close_main(app: AppHandle) {
    destroy_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_close_asks_the_page() {
        let c = Closing::default();
        assert!(c.begin());
        assert!(!c.begin(), "a second click waits for the same save");
    }
}
