//! Read-only git status/diff for the Changes tab.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileStatus {
    pub path: String,
    /// One of M A D R C U ? (untracked)
    pub status: String,
    pub staged: bool,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct GitStatus {
    pub is_repo: bool,
    pub files: Vec<FileStatus>,
    pub error: Option<String>,
}

/// Parses `git status --porcelain=v1 -z` output.
pub fn parse_porcelain_z(out: &[u8]) -> Vec<FileStatus> {
    let mut files = Vec::new();
    let mut parts = out.split(|b| *b == 0).peekable();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = entry[0] as char;
        let y = entry[1] as char;
        let path = String::from_utf8_lossy(&entry[3..]).to_string();
        let (status, staged) = if x == '?' {
            ("?".to_string(), false)
        } else if x != ' ' && x != '.' {
            (x.to_string(), true)
        } else {
            (y.to_string(), false)
        };
        let mut old_path = None;
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            if let Some(orig) = parts.next() {
                old_path = Some(String::from_utf8_lossy(orig).to_string());
            }
        }
        files.push(FileStatus { path, status, staged, old_path });
    }
    files
}

/// A real git, found once. Launched from Finder the PATH is minimal and `/usr/bin/git`
/// is only the Xcode shim, so prefer Homebrew/local installs.
fn git_bin() -> &'static str {
    static BIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        for c in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"] {
            if std::path::Path::new(c).exists() {
                return c.to_string();
            }
        }
        "git".to_string()
    })
}

fn git(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(git_bin())
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(cwd)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))
}

// A newly initialized repository has no HEAD yet. Comparing with its empty tree
// still includes staged files and subsequent working-tree edits.
fn diff_base(path: &str) -> Result<String, String> {
    if git(path, &["rev-parse", "--verify", "HEAD"])?.status.success() {
        return Ok("HEAD".into());
    }
    let out = git(path, &["hash-object", "-t", "tree", "--stdin"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub async fn git_status(path: String) -> GitStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let out = match git(&path, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]) {
            Ok(o) => o,
            Err(e) => return GitStatus { error: Some(e), ..Default::default() },
        };
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            if err.contains("not a git repository") {
                return GitStatus { is_repo: false, files: vec![], error: None };
            }
            if err.contains("developer tools") || err.contains("xcode-select") {
                return GitStatus { is_repo: false, files: vec![], error: Some("git is not installed (run: xcode-select --install)".into()) };
            }
            return GitStatus { is_repo: true, files: vec![], error: Some(err.trim().to_string()) };
        }
        GitStatus { is_repo: true, files: parse_porcelain_z(&out.stdout), error: None }
    })
    .await
    .unwrap_or_else(|e| GitStatus { error: Some(e.to_string()), ..Default::default() })
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, untracked: bool, old_path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = if untracked {
            git(&path, &["diff", "--no-color", "--no-index", "--", "/dev/null", &file])?
        } else {
            let base = diff_base(&path)?;
            let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", &base, "--"];
            if let Some(op) = old_path.as_deref() {
                args.push(op);
            }
            args.push(&file);
            git(&path, &args)?
        };
        // `git diff --no-index` exits 1 when files differ.
        if !out.status.success() && out.status.code() != Some(1) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct GitSummary {
    pub path: String,
    pub is_repo: bool,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub branch: String,
}

fn summary_one(path: &str) -> GitSummary {
    let mut s = GitSummary { path: path.to_string(), ..Default::default() };
    let Ok(st) = git(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) else { return s };
    if !st.status.success() {
        return s;
    }
    s.is_repo = true;
    s.files = parse_porcelain_z(&st.stdout).len() as u32;
    if let Ok(b) = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        if b.status.success() {
            s.branch = String::from_utf8_lossy(&b.stdout).trim().to_string();
        } else if let Ok(head) = git(path, &["rev-parse", "--short", "HEAD"]) {
            if head.status.success() {
                s.branch = String::from_utf8_lossy(&head.stdout).trim().to_string();
            }
        }
    }
    let base = diff_base(path).unwrap_or_else(|_| "HEAD".into());
    if let Ok(d) = git(path, &["diff", "--numstat", &base]) {
        for line in String::from_utf8_lossy(&d.stdout).lines() {
            let mut it = line.split('\t');
            if let (Some(a), Some(r)) = (it.next(), it.next()) {
                s.additions += a.parse::<u32>().unwrap_or(0);
                s.deletions += r.parse::<u32>().unwrap_or(0);
            }
        }
    }
    s
}

/// Cheap per-project git summary for badges (files changed, +/- lines, branch).
#[tauri::command]
pub async fn git_summary(paths: Vec<String>) -> Vec<GitSummary> {
    // One blocking task per project so a slow monorepo doesn't delay the others.
    let handles: Vec<_> = paths.into_iter().map(|p| tauri::async_runtime::spawn_blocking(move || summary_one(&p))).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(s) = h.await {
            out.push(s);
        }
    }
    out
}

/// `git worktree add -b <branch> <sibling dir>`; returns the new folder.
#[tauri::command]
pub async fn git_worktree_add(path: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = branch.trim().to_string();
        if branch.is_empty() || branch.contains(char::is_whitespace) {
            return Err("branch name must be a single word".into());
        }
        let root = std::path::Path::new(&path);
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or("repo".into());
        let safe = branch.replace('/', "-");
        let target = root.parent().unwrap_or(root).join(format!("{name}-{safe}"));
        if target.exists() {
            return Err(format!("{} already exists", target.display()));
        }
        let t = target.to_string_lossy().to_string();
        // Reuse the branch if it exists, otherwise create it from HEAD.
        let exists = git(&path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])?.status.success();
        let out = if exists {
            git(&path, &["worktree", "add", &t, &branch])?
        } else {
            git(&path, &["worktree", "add", "-b", &branch, &t])?
        };
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(t)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRepo(std::path::PathBuf);
    impl TestRepo {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("hangar-git-{}-{stamp}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            assert!(git(dir.to_str().unwrap(), &["init", "-q", "-b", "main"]).unwrap().status.success());
            Self(dir)
        }
        fn path(&self) -> &str { self.0.to_str().unwrap() }
    }
    impl Drop for TestRepo {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn diffs_before_first_commit_include_working_tree_edits_and_literal_paths() {
        let repo = TestRepo::new();
        std::fs::write(repo.0.join("[draft].txt"), "staged\n").unwrap();
        std::fs::write(repo.0.join("d.txt"), "unrelated\n").unwrap();
        assert!(git(repo.path(), &["add", "."]).unwrap().status.success());
        std::fs::write(repo.0.join("[draft].txt"), "latest\nsecond line\n").unwrap();
        let diff = git_diff(repo.path().into(), "[draft].txt".into(), false, None).await.unwrap();
        assert!(diff.contains("+latest\n+second line"), "{diff}");
        assert!(!diff.contains("unrelated"), "{diff}");
        let summary = summary_one(repo.path());
        assert_eq!(summary.branch, "main");
        assert_eq!(summary.additions, 3);
        assert_eq!(summary.deletions, 0);
    }

    #[test]
    fn parses_modified_added_untracked_and_rename() {
        let raw = b" M src/a.rs\0A  src/new.rs\0?? notes.txt\0R  src/b2.rs\0src/b.rs\0MM both.rs\0";
        let f = parse_porcelain_z(raw);
        assert_eq!(f.len(), 5);
        assert_eq!(f[0], FileStatus { path: "src/a.rs".into(), status: "M".into(), staged: false, old_path: None });
        assert_eq!(f[1], FileStatus { path: "src/new.rs".into(), status: "A".into(), staged: true, old_path: None });
        assert_eq!(f[2].status, "?");
        assert_eq!(f[3], FileStatus { path: "src/b2.rs".into(), status: "R".into(), staged: true, old_path: Some("src/b.rs".into()) });
        assert_eq!(f[4].status, "M");
        assert!(f[4].staged);
    }
}
