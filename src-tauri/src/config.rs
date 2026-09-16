//! `config.json` load/save (schema owned by the frontend).

use std::path::PathBuf;

fn config_path() -> PathBuf {
    hangard::default_data_dir().join("config.json")
}

#[tauri::command]
pub fn config_load() -> Result<serde_json::Value, String> {
    let p = config_path();
    let Ok(raw) = std::fs::read(&p) else { return Ok(serde_json::Value::Null) };
    match serde_json::from_slice(&raw) {
        Ok(v) => Ok(v),
        Err(e) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = std::fs::rename(&p, p.with_extension(format!("json.broken-{ts}")));
            eprintln!("config.json unreadable ({e}); backed up and starting empty");
            Ok(serde_json::Value::Null)
        }
    }
}

#[tauri::command]
pub fn config_save(value: serde_json::Value) -> Result<(), String> {
    let p = config_path();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
