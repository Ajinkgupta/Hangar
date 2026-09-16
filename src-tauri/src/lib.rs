//! Hangar app backend. `run()` builds the Tauri app; `--daemon` is handled in main.rs.

pub mod config;
pub mod daemon_client;
pub mod git;
pub mod monitor;


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(daemon_client::DaemonState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                daemon_client::start(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_client::pty_list,
            daemon_client::pty_create,
            daemon_client::pty_scrollback,
            daemon_client::pty_write,
            daemon_client::pty_resize,
            daemon_client::pty_kill,
            daemon_client::pty_forget,
            daemon_client::daemon_status,
            monitor::monitor_tick,
            monitor::kill_process,
            git::git_status,
            git::git_diff,
            config::config_load,
            config::config_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hangar");
}
