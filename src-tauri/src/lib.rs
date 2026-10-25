mod llm;
mod mcp;
mod shell;
mod tools;



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // 快捷键由前端按用户设置注册（见 App.tsx），Rust 只装插件
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            tools::check_update,
            tools::memory_read,
            tools::web_fetch,
            tools::web_search,
            tools::list_changes,
            tools::undo_changes,
            mcp::mcp_load_config,
            mcp::mcp_save_config,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_all_tools,
            mcp::mcp_status,
            mcp::mcp_call_tool,
        ])
        .run(tauri::generate_context!())
        .expect("小舟启动失败");
}
