//! Shared task storage for the GUI and agent CLI, independent of terminal daemons.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::{self, OpenOptions}, io::Write, os::unix::{fs::OpenOptionsExt, io::AsRawFd}, path::Path, time::{SystemTime, UNIX_EPOCH}};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Action {
    List,
    Add { text: String },
    Update { id: String, text: Option<String>, done: Option<bool> },
    Delete { id: String },
    ClearDone,
}

type Database = BTreeMap<String, Vec<Task>>;

fn title(text: String) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() { return Err("Task text cannot be empty".into()); }
    if text.len() > 16_384 { return Err("Task text is too long (maximum 16 KB)".into()); }
    Ok(text.to_owned())
}

pub fn apply(data_dir: &Path, root: &Path, action: Action) -> Result<Vec<Task>, String> {
    let root = root.canonicalize().map_err(|e| format!("Project folder: {e}"))?;
    if !root.is_dir() { return Err("Project must be a folder".into()); }
    let key = root.to_string_lossy().to_string();
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    // flock serializes read/modify/write across separate CLI and GUI processes.
    // The lock inode is never renamed or removed. Dropping the handle unlocks it.
    let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600)
        .open(data_dir.join("tasks.lock")).map_err(|e| e.to_string())?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let path = data_dir.join("tasks.json");
    let mut db: Database = match fs::read(&path) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|e| format!("Could not read tasks.json: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut changed = !db.contains_key(&key);
    if changed {
        // Migrate the original config checklist once. Later config saves cannot
        // overwrite agent-created tasks, and deleted tasks stay deleted.
        let legacy = match fs::read(data_dir.join("config.json")) {
            Ok(raw) => {
                let cfg: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| format!("Could not migrate tasks: {e}"))?;
                cfg.get("projects").and_then(|p| p.as_array()).and_then(|projects| projects.iter().find(|p| {
                    p.get("path").and_then(|p| p.as_str()).and_then(|p| Path::new(p).canonicalize().ok()).as_ref() == Some(&root)
                })).and_then(|p| p.get("tasks")).cloned().unwrap_or(serde_json::json!([]))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!([]),
            Err(e) => return Err(e.to_string()),
        };
        db.insert(key.clone(), serde_json::from_value(legacy).map_err(|e| format!("Could not migrate tasks: {e}"))?);
    }
    let tasks = db.get_mut(&key).unwrap();
    match action {
        Action::List => {},
        Action::Add { text } => {
            let text = title(text)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
            let id = format!("{:x}-{:x}", now.as_nanos(), std::process::id());
            tasks.insert(0, Task { id, text, done: false, created_at: now.as_millis() as u64 });
            changed = true;
        }
        Action::Update { id, text, done } => {
            let task = tasks.iter_mut().find(|t| t.id == id).ok_or("Task not found")?;
            if let Some(text) = text { task.text = title(text)?; }
            if let Some(done) = done { task.done = done; }
            changed = true;
        }
        Action::Delete { id } => {
            let index = tasks.iter().position(|t| t.id == id).ok_or("Task not found")?;
            tasks.remove(index);
            changed = true;
        }
        Action::ClearDone => { tasks.retain(|t| !t.done); changed = true; }
    }
    let result = tasks.clone();
    if changed {
        let tmp = data_dir.join("tasks.json.tmp");
        let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&db).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn tasks_apply(root: String, action: Action) -> Result<Vec<Task>, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&hangard::default_data_dir(), Path::new(&root), action))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tasks_cli_path() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())
}

const HELP: &str = "Hangar tasks — shared with the app, JSON output\n\nUsage: hangar tasks [--project PATH] COMMAND\nDefault project: current directory.\n\n  list\n  add TEXT\n  rename ID TEXT\n  done ID\n  reopen ID\n  delete ID\n\nQuote text and paths containing spaces. No running Hangar window is required.";

pub fn cli(args: &[String]) -> Result<(), String> {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) { println!("{HELP}"); return Ok(()); }
    let mut args = args;
    let mut root = std::env::current_dir().map_err(|e| e.to_string())?;
    if args.first().map(String::as_str) == Some("--project") {
        root = args.get(1).ok_or("--project requires a folder path")?.into();
        args = &args[2..];
    }
    let action = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["list"] | [] => Action::List,
        ["add", text] => Action::Add { text: (*text).into() },
        ["rename", id, text] => Action::Update { id: (*id).into(), text: Some((*text).into()), done: None },
        ["done", id] => Action::Update { id: (*id).into(), text: None, done: Some(true) },
        ["reopen", id] => Action::Update { id: (*id).into(), text: None, done: Some(false) },
        ["delete", id] => Action::Delete { id: (*id).into() },
        _ => return Err(HELP.into()),
    };
    let tasks = apply(&hangard::default_data_dir(), &root, action)?;
    println!("{}", serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hangar-tasks-{name}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap(); dir
    }
    #[test]
    fn migrates_once_and_keeps_config_separate() {
        let dir = fixture("migration");
        fs::write(dir.join("config.json"), serde_json::json!({"projects":[{"path":dir,"tasks":[{"id":"old","text":"Existing","done":false,"createdAt":1}]}]}).to_string()).unwrap();
        let list = apply(&dir, &dir, Action::List).unwrap();
        assert_eq!(list[0].id, "old");
        apply(&dir, &dir, Action::Delete { id:"old".into() }).unwrap();
        assert!(apply(&dir, &dir, Action::List).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_writers_do_not_lose_tasks_and_updates_are_per_task() {
        let dir = fixture("concurrent");
        let threads: Vec<_> = (0..12).map(|i| { let dir = dir.clone(); std::thread::spawn(move || apply(&dir, &dir, Action::Add { text: format!("Task {i}") }).unwrap()) }).collect();
        for t in threads { t.join().unwrap(); }
        let list = apply(&dir, &dir, Action::List).unwrap();
        assert_eq!(list.len(), 12);
        let id = list[0].id.clone();
        let updated = apply(&dir, &dir, Action::Update { id: id.clone(), text: None, done: Some(true) }).unwrap();
        assert_eq!(updated.iter().filter(|t| t.done).count(), 1);
        assert!(apply(&dir, &dir, Action::Add { text: " ".into() }).is_err());
        assert_eq!(apply(&dir, &dir, Action::List).unwrap().len(), 12);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_storage_is_not_overwritten() {
        let dir = fixture("corrupt");
        fs::write(dir.join("tasks.json"), "broken").unwrap();
        assert!(apply(&dir, &dir, Action::Add { text: "new".into() }).is_err());
        assert_eq!(fs::read_to_string(dir.join("tasks.json")).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
