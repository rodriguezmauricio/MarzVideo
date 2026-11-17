//! Marz Recorder desktop shell: a Tauri 2 window around the editor.

mod export;
mod projects;
mod recorder;
mod recording;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(projects::Allowed::default())
        .manage(recorder::Recorder::default())
        .manage(recording::Recording::default())
        .manage(export::Exports::default())
        .invoke_handler(tauri::generate_handler![
            projects::projects_dir,
            projects::list_projects,
            projects::pick_project,
            projects::read_text,
            projects::write_project_json,
            projects::recover_project,
            projects::discard_project,
            recorder::open_recorder,
            recorder::close_recorder,
            recorder::recorder_setup,
            recorder::list_mics,
            recorder::check_region,
            recorder::fit_bar,
            recorder::start_mic_meter,
            recorder::stop_mic_meter,
            recording::start_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::set_mic_muted,
            recording::trigger_zoom,
            recording::stop_recording,
            recording::recording_state,
            export::pick_export_path,
            export::export_begin,
            export::export_chunk,
            export::export_finish,
            export::export_cancel,
            export::show_in_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Marz Recorder")
        .run(|app, event| {
            // A running export must not leave FFmpeg or a `.part` file behind.
            if let tauri::RunEvent::Exit = event {
                app.state::<export::Exports>().cancel_all();
            }
        });
}
