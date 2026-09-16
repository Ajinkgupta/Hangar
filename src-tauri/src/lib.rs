//! Hangar app backend. `run()` builds the Tauri app; `--daemon` is handled in main.rs.

pub mod config;
pub mod daemon_client;
pub mod git;
pub mod monitor;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};


/// Opens an http(s) link in the user's default browser (terminal link clicks).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) links can be opened".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens a folder or file in the given editor app (e.g. "Cursor", "Visual Studio Code").
#[tauri::command]
fn open_in_editor(app_name: String, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} does not exist"));
    }
    std::process::Command::new("open")
        .arg("-a")
        .arg(&app_name)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Editors found in /Applications, in preference order.
#[tauri::command]
fn detect_editors() -> Vec<String> {
    ["Cursor", "Visual Studio Code", "Zed", "Windsurf", "Sublime Text"]
        .iter()
        .filter(|n| std::path::Path::new(&format!("/Applications/{n}.app")).exists())
        .map(|n| n.to_string())
        .collect()
}

/// macOS notification via osascript (no plugin, no permission prompt beyond the first).
#[tauri::command]
fn notify(title: String, body: String, sound: bool) -> Result<(), String> {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut script = format!("display notification \"{}\" with title \"Hangar\" subtitle \"{}\"", esc(&body), esc(&title));
    if sound {
        script.push_str(" sound name \"Glass\"");
    }
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn security(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("security").args(args).output().map_err(|e| e.to_string())
}

/// Stores a secret in the macOS Keychain (generic password, account "hangar").
#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let out = security(&["add-generic-password", "-a", "hangar", "-s", &key, "-w", &value, "-U"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
fn secret_get(key: String) -> Result<String, String> {
    let out = security(&["find-generic-password", "-a", "hangar", "-s", &key, "-w"])?;
    if !out.status.success() {
        return Err(format!("no secret stored for {key}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let _ = security(&["delete-generic-password", "-a", "hangar", "-s", &key])?;
    Ok(())
}

/// Menu-bar text: how many agents are waiting / running.
#[tauri::command]
fn tray_set_status(app: AppHandle, waiting: u32, running: u32) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let title = if waiting > 0 {
            format!("● {waiting}")
        } else if running > 0 {
            format!("{running}")
        } else {
            String::new()
        };
        tray.set_title(Some(title)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(format!("Hangar — {waiting} waiting, {running} agents running"))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &"cmd+shift+h".parse::<Shortcut>().unwrap() {
                        match app.get_webview_window("main") {
                            Some(w) if w.is_focused().unwrap_or(false) => {
                                let _ = w.hide();
                            }
                            _ => focus_main(app),
                        }
                    }
                })
                .build(),
        )
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
            // Menu-bar item: shows how many agents need attention; click focuses Hangar.
            let mut tray = TrayIconBuilder::with_id("main").tooltip("Hangar");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon).icon_as_template(false);
            }
            tray.on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    focus_main(tray.app_handle());
                }
            })
            .build(app)?;
            if let Err(e) = app.global_shortcut().register("cmd+shift+h".parse::<Shortcut>().unwrap()) {
                eprintln!("global shortcut not registered: {e}");
            }
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
            daemon_client::pty_tail,
            daemon_client::pty_write,
            daemon_client::pty_resize,
            daemon_client::pty_kill,
            daemon_client::pty_forget,
            daemon_client::daemon_status,
            daemon_client::daemon_restart,
            monitor::monitor_tick,
            monitor::kill_process,
            git::git_status,
            git::git_diff,
            git::git_summary,
            git::git_worktree_add,
            config::config_load,
            config::config_save,
            open_url,
            open_in_editor,
            detect_editors,
            notify,
            tray_set_status,
            secret_set,
            secret_get,
            secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hangar");
}
