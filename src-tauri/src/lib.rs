mod llm;
mod tools;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            llm::llm_stream,
            tools::run_tool,
            tools::cancel_tool,
            tools::default_workspace,
            tools::dir_exists,
            tools::project_guide,
            tools::load_sessions,
            tools::save_sessions,
            tools::read_reference,
            tools::list_files,
            tools::preview_change,
            tools::list_skills,
            tools::load_schedules,
            tools::save_schedules,
            tools::write_export,
        ])
        .run(tauri::generate_context!())
        .expect("小舟启动失败");
}
