//! Read-only project file browsing for the Files tab. Every path is confined to the
//! project root (canonicalised, must start with the root).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Heavy folders the UI shows collapsed and dimmed.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

const MAX_READ: u64 = 2 * 1024 * 1024;
const IGNORED: &[&str] = &["node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache"];

fn confine(root: &str, path: &str) -> Result<PathBuf, String> {
    let root_c = Path::new(root).canonicalize().map_err(|e| format!("project folder: {e}"))?;
    let p = if path.is_empty() { root_c.clone() } else { PathBuf::from(path) };
    let p_c = p.canonicalize().map_err(|e| format!("{}: {e}", p.display()))?;
    if !p_c.starts_with(&root_c) {
        return Err("path is outside the project".into());
    }
    Ok(p_c)
}

#[tauri::command]
pub async fn fs_list(root: String, dir: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = confine(&root, &dir)?;
        let mut out = Vec::new();
        for e in std::fs::read_dir(&d).map_err(|e| e.to_string())? {
            let Ok(e) = e else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" || name == ".DS_Store" {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let is_dir = meta.is_dir();
            out.push(Entry {
                path: e.path().to_string_lossy().to_string(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                ignored: is_dir && IGNORED.contains(&name.as_str()),
                name,
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read(root: String, path: String) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = confine(&root, &path)?;
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err("is a directory".into());
        }
        use std::io::Read;
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(meta.len().min(MAX_READ) as usize);
        f.by_ref().take(MAX_READ).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let binary = buf.iter().take(8000).any(|b| *b == 0);
        let content = if binary { String::new() } else { String::from_utf8_lossy(&buf).to_string() };
        Ok(FileContent { path: p.to_string_lossy().to_string(), content, size: meta.len(), truncated: meta.len() > MAX_READ, binary })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let mut child = std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
