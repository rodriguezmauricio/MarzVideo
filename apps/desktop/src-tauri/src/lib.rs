//! Marz Recorder desktop shell: a Tauri 2 window around the editor.

mod ai;
mod archive;
mod audio;
mod checklist;
mod close;
mod export;
mod export_copy;
mod projects;
mod recorder;
mod recording;
mod settings;
mod thumbs;
mod transcribe;
mod webview;

use tauri::Manager;

pub fn run() {
    webview::set_browser_args();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(projects::Allowed::default())
        .manage(recorder::Recorder::default())
        .manage(recording::Recording::default())
        .manage(export::Exports::default())
        .manage(close::Closing::default())
        .manage(ai::AiRun::default())
        .manage(checklist::ChecklistAi::default())
        .manage(transcribe::TranscribeRun::default())
        .manage(audio::Cleaning::default())
        .manage(archive::StorageJob::default())
        .manage(settings::SettingsMeter::default())
        .setup(|app| {
            settings::apply_stored_hotkeys(app.handle());
            Ok(())
        })
        .on_window_event(close::on_window_event)
        .invoke_handler(tauri::generate_handler![
            close::close_main,
            projects::projects_dir,
            projects::list_projects,
            projects::pick_project,
            projects::read_text,
            projects::write_project_json,
            projects::recover_project,
            projects::discard_project,
            thumbs::project_thumb,
            recorder::open_recorder,
            recorder::close_recorder,
            recorder::recorder_setup,
            recorder::list_mics,
            recorder::check_region,
            recorder::fit_bar,
            recorder::overlay_hits,
            recorder::drag_bar,
            recorder::start_mic_meter,
            recorder::stop_mic_meter,
            recording::start_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::set_mic_muted,
            recording::trigger_zoom,
            recording::set_preset_rect,
            recording::stop_recording,
            recording::recording_state,
            recording::toggle_draw,
            recording::draw_op,
            checklist::checklist_tick,
            checklist::checklist_ai,
            export::pick_export_path,
            export::export_begin,
            export::export_chunk,
            export::export_finish,
            export::export_cancel,
            export::export_cancel_all,
            export::show_in_folder,
            export::export_write_srt,
            export::export_write_vtt,
            export_copy::export_copy_settings,
            export_copy::pick_export_copy_dest,
            export_copy::clear_export_copy_dest,
            export_copy::export_copy_to,
            ai::ai_edit_pass,
            ai::ai_cancel,
            transcribe::transcribe,
            transcribe::transcribe_cancel,
            transcribe::model_status,
            transcribe::download_model,
            audio::audio_clean_mic,
            archive::archive_settings,
            archive::pick_archive_dest,
            archive::use_suggested_dest,
            archive::project_storage,
            archive::archive_project,
            archive::remove_raw_files,
            archive::restore_raw_files,
            settings::settings_get,
            settings::settings_pick_folder,
            settings::settings_reset_folder,
            settings::settings_use_drive,
            settings::settings_set_hotkeys,
            settings::settings_set_onboarding,
            settings::settings_devices,
            settings::settings_meter,
            settings::ai_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Marz Recorder")
        .run(|app, event| {
            // A running export must not leave FFmpeg or a `.part` file behind.
            if let tauri::RunEvent::Exit = event {
                app.state::<export::Exports>().cancel_all();
                ai::ai_cancel(app.state::<ai::AiRun>());
                checklist::cancel_ai(&app.state::<checklist::ChecklistAi>());
            }
        });
}
