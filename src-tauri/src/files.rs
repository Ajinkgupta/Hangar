//! Project file browsing and editing. Every path is confined to the
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
    let p = root_c.join(path);
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
        if !meta.is_file() {
            return Err("Only regular files can be opened".into());
        }
        use std::io::Read;
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(meta.len().min(MAX_READ) as usize);
        f.by_ref().take(MAX_READ).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let valid_text = std::str::from_utf8(&buf).is_ok() || (meta.len() > MAX_READ && std::str::from_utf8(&buf).err().is_some_and(|e| e.error_len().is_none()));
        let binary = buf.contains(&0) || !valid_text;
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

// Serialize saves made by the UI. External writes are checked against the full
// original bytes before replacing the file, and a save never truncates in place.
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn write_file(root: &str, path: &str, expected: &str, content: &str) -> Result<(), String> {
    use std::io::Write;
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_READ || content.contains('\0') {
        return Err("Only text files up to 2 MB can be saved".into());
    }
    let p = confine(root, path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_READ {
        return Err("Only complete regular text files up to 2 MB can be edited".into());
    }
    let current = std::fs::read(&p).map_err(|e| e.to_string())?;
    if current != expected.as_bytes() {
        return Err("This file changed on disk. Your draft is safe. Reload the disk version before saving again.".into());
    }
    if current.contains(&0) || std::str::from_utf8(&current).is_err() {
        return Err("This file is not UTF-8 text".into());
    }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let tmp = p.parent().ok_or("Missing parent folder")?.join(format!(".hangar-save-{}-{nonce}", std::process::id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        f.set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        // Recheck after writing the temporary file, in case an agent saved while we wrote.
        if std::fs::read(&p).map_err(|e| e.to_string())? != current {
            return Err("This file changed on disk while saving. Your draft is safe; reload before saving again.".into());
        }
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result
}

#[tauri::command]
pub async fn fs_write(root: String, path: String, expected: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file(&root, &path, &expected, &content))
        .await.map_err(|e| e.to_string())?
}

fn create_entry(root: &str, path: &str, directory: bool) -> Result<String, String> {
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let requested = root.join(path);
    let name = requested.file_name().ok_or("Enter a file or folder name")?;
    let parent = requested.parent().ok_or("Missing parent folder")?;
    let parent = confine(&root.to_string_lossy(), &parent.to_string_lossy())?;
    let target = parent.join(name);
    if directory { std::fs::create_dir(&target).map_err(|e| e.to_string())?; }
    else { std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?; }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn fs_create(root: String, path: String, directory: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create_entry(&root, &path, directory))
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> PathBuf {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("hangar-files-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap(); dir
    }
    #[test]
    fn save_preserves_permissions_and_rejects_stale_content() {
        let dir = fixture(); let root = dir.to_str().unwrap();
        let path = create_entry(root, "script.sh", false).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_file(root, &path, "", "echo hi\n").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::write(&path, "agent update\n").unwrap();
        assert!(write_file(root, &path, "echo hi\n", "my edit\n").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "agent update\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn binary_and_oversized_files_cannot_be_overwritten() {
        let dir = fixture(); let root = dir.to_str().unwrap();
        std::fs::write(dir.join("binary"), b"a\0b").unwrap();
        assert!(write_file(root, "binary", "a\0b", "text").is_err());
        assert_eq!(std::fs::read(dir.join("binary")).unwrap(), b"a\0b");
        let large = vec![b'a'; MAX_READ as usize + 1];
        std::fs::write(dir.join("large"), &large).unwrap();
        assert!(write_file(root, "large", "a", "new").is_err());
        assert_eq!(std::fs::metadata(dir.join("large")).unwrap().len(), MAX_READ + 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn paths_and_symlinks_cannot_escape_and_create_never_overwrites() {
        let dir = fixture(); let outside = fixture(); let root = dir.to_str().unwrap();
        std::fs::write(outside.join("secret"), "outside").unwrap();
        symlink(&outside, dir.join("link")).unwrap();
        assert!(write_file(root, "link/secret", "outside", "changed").is_err());
        assert!(create_entry(root, "link/new", false).is_err());
        assert!(create_entry(root, &outside.join("new").to_string_lossy(), false).is_err());
        create_entry(root, "folder", true).unwrap();
        let file = create_entry(root, "folder/new.txt", false).unwrap();
        std::fs::write(&file, "keep").unwrap();
        assert!(create_entry(root, "folder/new.txt", false).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "keep");
        std::fs::remove_dir_all(dir).unwrap(); std::fs::remove_dir_all(outside).unwrap();
    }
}
