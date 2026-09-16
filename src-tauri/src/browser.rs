//! Embedded preview browsers: one child WKWebView per project, positioned by the UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, WebviewBuilder, WebviewUrl};

#[derive(Default)]
pub struct BrowserState {
    labels: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<Bounds> for Rect {
    fn from(b: Bounds) -> Rect {
        Rect {
            position: LogicalPosition::new(b.x, b.y).into(),
            size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into(),
        }
    }
}

#[derive(Serialize, Clone)]
struct Navigated {
    project_id: String,
    url: String,
    finished: bool,
}

fn label_for(project_id: &str) -> String {
    format!("browser-{project_id}")
}

fn parse_url(url: &str) -> Result<url::Url, String> {
    let u = if url.contains("://") { url.to_string() } else { format!("http://{url}") };
    url::Url::parse(&u).map_err(|e| e.to_string())
}

fn webview(app: &AppHandle, project_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&label_for(project_id)).ok_or_else(|| "no browser for project".to_string())
}

#[tauri::command]
pub fn browser_show(
    app: AppHandle,
    state: State<'_, BrowserState>,
    project_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    let label = label_for(&project_id);
    let target = parse_url(&url)?;
    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(bounds.into()).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        let current = wv.url().map(|u| u.to_string()).unwrap_or_default();
        if current != target.as_str() {
            wv.navigate(target).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let pid = project_id.clone();
    let app2 = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_page_load(move |wv, payload| {
            let finished = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
            let _ = app2.emit(
                "browser:navigated",
                Navigated { project_id: pid.clone(), url: payload.url().to_string(), finished },
            );
            let _ = wv;
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    state.labels.lock().unwrap().insert(project_id, label);
    Ok(())
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, project_id: String) -> Result<(), String> {
    if let Ok(wv) = webview(&app, &project_id) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, project_id: String, url: String) -> Result<(), String> {
    webview(&app, &project_id)?.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, project_id: String) -> Result<(), String> {
    webview(&app, &project_id)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, project_id: String) -> Result<(), String> {
    webview(&app, &project_id)?.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, project_id: String) -> Result<(), String> {
    webview(&app, &project_id)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, project_id: String, bounds: Bounds) -> Result<(), String> {
    if let Ok(wv) = webview(&app, &project_id) {
        wv.set_bounds(bounds.into()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_destroy(app: AppHandle, state: State<'_, BrowserState>, project_id: String) -> Result<(), String> {
    state.labels.lock().unwrap().remove(&project_id);
    if let Ok(wv) = webview(&app, &project_id) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
