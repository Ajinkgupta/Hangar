//! Hangar app backend. `run()` builds the Tauri app; `--daemon` is handled in main.rs.

pub mod browser;
pub mod config;
pub mod daemon_client;
pub mod git;
pub mod monitor;

use tauri::{LogicalPosition, WebviewBuilder, WebviewUrl};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(daemon_client::DaemonState::default())
        .manage(browser::BrowserState::default())
        .setup(|app| {
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Hangar")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            let size = window.inner_size()?;
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::default()).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
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
            browser::browser_show,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_destroy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hangar");
}
