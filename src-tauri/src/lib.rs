mod llm;
mod mcp;
mod tools;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+space"])
                .expect("注册全局快捷键失败")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            let focused = window.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = window.hide();
                            } else {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
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
