//! Marz Recorder desktop shell: a Tauri 2 window around the editor.

mod projects;
mod recorder;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(projects::Allowed::default())
        .manage(recorder::Recorder::default())
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
            recorder::start_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Marz Recorder");
}
