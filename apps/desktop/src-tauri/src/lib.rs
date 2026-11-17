//! Marz Recorder desktop shell: a Tauri 2 window around the editor.

mod projects;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(projects::Allowed::default())
        .invoke_handler(tauri::generate_handler![
            projects::projects_dir,
            projects::list_projects,
            projects::pick_project,
            projects::read_text,
            projects::write_project_json,
            projects::recover_project,
            projects::discard_project,
            projects::open_recorder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Marz Recorder");
}
