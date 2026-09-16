//! Port/process monitor: `lsof` for listeners, `ps` for the process tree, and
//! attribution of each listener to the Hangar session whose shell spawned it.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Listener {
    pub pid: u32,
    pub process: String,
    pub addr: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PortRow {
    pub port: u16,
    pub addr: String,
    pub pid: u32,
    pub process: String,
    pub session_id: Option<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorSnapshot {
    pub ports: Vec<PortRow>,
    /// session id -> number of processes running under that session's shell
    pub activity: HashMap<String, u32>,
    pub error: Option<String>,
}

/// Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output.
pub fn parse_lsof(out: &str) -> Vec<Listener> {
    let mut rows = Vec::new();
    let mut pid = 0u32;
    let mut process = String::new();
    let mut seen: HashSet<(u32, u16)> = HashSet::new();
    for line in out.lines() {
        let Some(first) = line.chars().next() else { continue };
        let rest = &line[1..];
        match first {
            'p' => pid = rest.trim().parse().unwrap_or(0),
            'c' => process = rest.trim().to_string(),
            'n' => {
                // e.g. "*:3000", "127.0.0.1:5173", "[::1]:8080"
                let name = rest.trim();
                let Some(idx) = name.rfind(':') else { continue };
                let Ok(port) = name[idx + 1..].parse::<u16>() else { continue };
                let addr = name[..idx].to_string();
                if seen.insert((pid, port)) {
                    rows.push(Listener { pid, process: process.clone(), addr, port });
                }
            }
            _ => {}
        }
    }
    rows
}

/// Parses `ps -axo pid=,ppid=,comm=` into pid -> ppid.
pub fn parse_ps(out: &str) -> HashMap<u32, u32> {
    let mut m = HashMap::new();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        let (Some(p), Some(pp)) = (it.next(), it.next()) else { continue };
        if let (Ok(p), Ok(pp)) = (p.parse(), pp.parse()) {
            m.insert(p, pp);
        }
    }
    m
}

/// Finds which session (by shell pid) is an ancestor of `pid`, if any.
pub fn owning_session(pid: u32, parents: &HashMap<u32, u32>, sessions: &HashMap<u32, String>) -> Option<String> {
    let mut cur = pid;
    for _ in 0..64 {
        if let Some(id) = sessions.get(&cur) {
            return Some(id.clone());
        }
        match parents.get(&cur) {
            Some(&pp) if pp != cur && pp != 0 => cur = pp,
            _ => return None,
        }
    }
    None
}

pub fn build_rows(
    listeners: Vec<Listener>,
    parents: &HashMap<u32, u32>,
    sessions: &HashMap<u32, String>,
) -> Vec<PortRow> {
    let mut by_port: HashMap<u16, HashSet<u32>> = HashMap::new();
    for l in &listeners {
        by_port.entry(l.port).or_default().insert(l.pid);
    }
    let mut rows: Vec<PortRow> = listeners
        .into_iter()
        .map(|l| PortRow {
            conflict: by_port.get(&l.port).map(|s| s.len() > 1).unwrap_or(false),
            session_id: owning_session(l.pid, parents, sessions),
            port: l.port,
            addr: l.addr,
            pid: l.pid,
            process: l.process,
        })
        .collect();
    rows.sort_by_key(|r| (r.port, r.pid));
    rows
}

/// Counts descendants of each session shell.
pub fn activity(parents: &HashMap<u32, u32>, sessions: &HashMap<u32, String>) -> HashMap<String, u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&p, &pp) in parents {
        children.entry(pp).or_default().push(p);
    }
    let mut out = HashMap::new();
    for (&pid, id) in sessions {
        let mut count = 0u32;
        let mut stack = vec![pid];
        while let Some(p) = stack.pop() {
            if let Some(kids) = children.get(&p) {
                count += kids.len() as u32;
                stack.extend(kids.iter().copied());
            }
        }
        out.insert(id.clone(), count);
    }
    out
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
    // lsof exits 1 when nothing matches; that's not an error for us.
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `session_pids`: session id -> shell pid, as reported by the daemon.
#[tauri::command]
pub async fn monitor_tick(session_pids: HashMap<String, u32>) -> MonitorSnapshot {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions: HashMap<u32, String> = session_pids.into_iter().map(|(id, pid)| (pid, id)).collect();
        let ps = match run("ps", &["-axo", "pid=,ppid=,comm="]) {
            Ok(s) => s,
            Err(e) => return MonitorSnapshot { error: Some(e), ..Default::default() },
        };
        let parents = parse_ps(&ps);
        let lsof = match run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]) {
            Ok(s) => s,
            Err(e) => return MonitorSnapshot { error: Some(e), ..Default::default() },
        };
        MonitorSnapshot {
            ports: build_rows(parse_lsof(&lsof), &parents, &sessions),
            activity: activity(&parents, &sessions),
            error: None,
        }
    })
    .await
    .unwrap_or_else(|e| MonitorSnapshot { error: Some(e.to_string()), ..Default::default() })
}

#[tauri::command]
pub fn kill_process(pid: u32, force: bool) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("refusing to kill that process".into());
    }
    let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc != 0 {
        return Err(format!("kill failed: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LSOF: &str = "p1967\ncCursor Helper (Plugin)\nf36\nn127.0.0.1:25057\np4242\ncnode\nf23\nn*:3000\nf24\nn[::1]:3000\np5151\ncpython3.12\nf5\nn*:3000\n";

    #[test]
    fn parses_lsof_and_dedupes_v4_v6_of_same_pid() {
        let l = parse_lsof(LSOF);
        assert_eq!(l.len(), 3);
        assert_eq!(l[0], Listener { pid: 1967, process: "Cursor Helper (Plugin)".into(), addr: "127.0.0.1".into(), port: 25057 });
        assert_eq!(l[1].port, 3000);
        assert_eq!(l[1].addr, "*");
        assert_eq!(l[2].process, "python3.12");
    }

    #[test]
    fn attributes_listener_to_session_via_ancestry_and_flags_conflicts() {
        let parents = parse_ps("1 0 launchd\n100 1 zsh\n4242 100 node\n5151 1 python\n");
        let sessions: HashMap<u32, String> = [(100u32, "proj:shell".to_string())].into();
        let rows = build_rows(parse_lsof(LSOF), &parents, &sessions);
        let node = rows.iter().find(|r| r.pid == 4242).unwrap();
        assert_eq!(node.session_id.as_deref(), Some("proj:shell"));
        assert!(node.conflict);
        let py = rows.iter().find(|r| r.pid == 5151).unwrap();
        assert_eq!(py.session_id, None);
        assert!(py.conflict);
        let cursor = rows.iter().find(|r| r.pid == 1967).unwrap();
        assert!(!cursor.conflict);
        assert_eq!(activity(&parents, &sessions).get("proj:shell"), Some(&1));
    }
}
