//! Hangar app backend. `run()` builds the Tauri app; `--daemon` is handled in main.rs.

pub mod config;
pub mod daemon_client;
pub mod git;
pub mod monitor;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(daemon_client::DaemonState::default())
        .setup(|app| {
            // Custom menu: keeps the Edit items (needed for Cmd+C/V in the terminal) but
            // drops "Close Window" so Cmd+W can close a terminal tab instead of the app.
            let menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Hangar",
                        true,
                        &[
                            &PredefinedMenuItem::about(app, None, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, None)?,
                            &PredefinedMenuItem::hide_others(app, None)?,
                            &PredefinedMenuItem::show_all(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, None)?,
                            &PredefinedMenuItem::redo(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[
                            &PredefinedMenuItem::minimize(app, None)?,
                            &PredefinedMenuItem::maximize(app, None)?,
                            &PredefinedMenuItem::fullscreen(app, None)?,
                        ],
                    )?,
                ],
            )?;
            app.set_menu(menu)?;
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
