//! Marz Recorder desktop shell: a Tauri 2 window around the editor.

// The capture engine is wired in by the recorder commands (later tasks); link it now.
use marz_capture as _;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Marz Recorder");
}
