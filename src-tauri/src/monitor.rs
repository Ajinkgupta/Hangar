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
    /// session id -> name of the coding agent running in it (claude, codex, ...)
    pub agents: HashMap<String, String>,
    pub error: Option<String>,
}

/// Process names that count as "an agent is running here".
const AGENTS: &[&str] = &["claude", "codex", "cursor-agent", "aider", "gemini", "opencode", "amp", "copilot", "goose"];

/// For every session shell, the first agent found among its descendants.
pub fn agents(procs: &HashMap<u32, Proc>, sessions: &HashMap<u32, String>) -> HashMap<String, String> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&p, info) in procs {
        children.entry(info.ppid).or_default().push(p);
    }
    let mut out = HashMap::new();
    for (&pid, id) in sessions {
        let mut stack = vec![pid];
        'walk: while let Some(p) = stack.pop() {
            if let Some(kids) = children.get(&p) {
                for &k in kids {
                    let name = procs.get(&k).map(|x| x.name.to_ascii_lowercase()).unwrap_or_default();
                    // node-based agents show up as "node"; their script path is not in comm, so
                    // also accept a parent shell wrapper named after the agent.
                    if let Some(a) = AGENTS.iter().find(|a| name == **a || name.starts_with(&format!("{a} ")) || name.ends_with(&format!("/{a}"))) {
                        out.insert(id.clone(), a.to_string());
                        break 'walk;
                    }
                    stack.push(k);
                }
            }
        }
    }
    out
}

/// Parses `netstat -anv -p tcp` output: one listener per (pid, port).
/// The process-name column is truncated by netstat, so names come from `ps`.
pub fn parse_netstat(out: &str) -> Vec<Listener> {
    let mut rows = Vec::new();
    let mut seen: HashSet<(u32, u16)> = HashSet::new();
    for line in out.lines() {
        if !line.starts_with("tcp") || !line.contains("LISTEN") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 || cols[5] != "LISTEN" {
            continue;
        }
        // local address: 127.0.0.1.25057 / *.51896 / ::1.1420
        let local = cols[3];
        let Some(dot) = local.rfind('.') else { continue };
        let Ok(port) = local[dot + 1..].parse::<u16>() else { continue };
        let addr = local[..dot].to_string();
        // pid: the "<name>:<pid>" token after LISTEN; name may contain spaces.
        let Some(pid) = cols[6..].iter().find_map(|t| {
            let i = t.rfind(':')?;
            t[i + 1..].parse::<u32>().ok().filter(|_| i > 0 || t.len() > 1)
        }) else {
            continue;
        };
        if seen.insert((pid, port)) {
            rows.push(Listener { pid, process: String::new(), addr, port });
        }
    }
    rows
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub ppid: u32,
    pub name: String,
}

/// Parses `ps -axo pid=,ppid=,comm=` into pid -> (ppid, short name).
pub fn parse_ps(out: &str) -> HashMap<u32, Proc> {
    let mut m = HashMap::new();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        let (Some(p), Some(pp)) = (it.next(), it.next()) else { continue };
        let comm: Vec<&str> = it.collect();
        let comm = comm.join(" ");
        let name = comm.rsplit('/').next().unwrap_or(&comm).to_string();
        if let (Ok(p), Ok(pp)) = (p.parse(), pp.parse()) {
            m.insert(p, Proc { ppid: pp, name });
        }
    }
    m
}

/// Finds which session (by shell pid) is an ancestor of `pid`, if any.
pub fn owning_session(pid: u32, procs: &HashMap<u32, Proc>, sessions: &HashMap<u32, String>) -> Option<String> {
    let mut cur = pid;
    for _ in 0..64 {
        if let Some(id) = sessions.get(&cur) {
            return Some(id.clone());
        }
        match procs.get(&cur) {
            Some(p) if p.ppid != cur && p.ppid != 0 => cur = p.ppid,
            _ => return None,
        }
    }
    None
}

pub fn build_rows(
    listeners: Vec<Listener>,
    procs: &HashMap<u32, Proc>,
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
            session_id: owning_session(l.pid, procs, sessions),
            port: l.port,
            addr: l.addr,
            pid: l.pid,
            process: if l.process.is_empty() {
                procs.get(&l.pid).map(|p| p.name.clone()).unwrap_or_else(|| "?".into())
            } else {
                l.process
            },
        })
        .collect();
    rows.sort_by_key(|r| (r.port, r.pid));
    rows
}

/// Counts descendants of each session shell.
pub fn activity(procs: &HashMap<u32, Proc>, sessions: &HashMap<u32, String>) -> HashMap<String, u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&p, info) in procs {
        children.entry(info.ppid).or_default().push(p);
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

/// Removes ANSI escape sequences (CSI, OSC, simple ESC-x) and other control bytes.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    // CSI: params then a final byte 0x40..=0x7e
                    for d in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: until BEL or ESC \
                    let mut prev = ' ';
                    for d in chars.by_ref() {
                        if d == '\x07' || (prev == '\x1b' && d == '\\') {
                            break;
                        }
                        prev = d;
                    }
                }
                Some(_) | None => {}
            }
            continue;
        }
        if c == '\n' || c == '\r' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
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
        let procs = parse_ps(&ps);
        let ns = match run("netstat", &["-anv", "-p", "tcp"]) {
            Ok(s) => s,
            Err(e) => return MonitorSnapshot { error: Some(e), ..Default::default() },
        };
        MonitorSnapshot {
            ports: build_rows(parse_netstat(&ns), &procs, &sessions),
            activity: activity(&procs, &sessions),
            agents: agents(&procs, &sessions),
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
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(()); // already gone; the next monitor tick drops the row
        }
        return Err(format!("kill failed: {err}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT: &str = "Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rxbytes txbytes rhiwat shiwat process:pid
tcp6       0      0  ::1.1420               *.*                    LISTEN      0       0       131072 131072 node:23154 00100
tcp4       0      0  127.0.0.1.25057        *.*                    LISTEN      0       0       131072 131072 Cursor Helper (P:1967 00100
tcp4       0      0  *.3000                 *.*                    LISTEN      0       0       131072 131072 node:4242 00100
tcp6       0      0  *.3000                 *.*                    LISTEN      0       0       131072 131072 node:4242 00100
tcp4       0      0  *.3000                 *.*                    LISTEN      0       0       131072 131072 python3.12:5151 00100
tcp4       0      0  127.0.0.1.52000        127.0.0.1.52001        ESTABLISHED 0       0       131072 131072 node:4242 00100
";

    const PS: &str = "1 0 /sbin/launchd\n100 1 /bin/zsh\n4242 100 /opt/homebrew/bin/node\n5151 1 /usr/bin/python3.12\n1967 1 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)\n23154 1 node\n";

    #[test]
    fn parses_netstat_listeners_and_dedupes_v4_v6_of_same_pid() {
        let l = parse_netstat(NETSTAT);
        assert_eq!(l.len(), 4);
        assert_eq!(l[0].port, 1420);
        assert_eq!(l[0].pid, 23154);
        assert_eq!(l[0].addr, "::1");
        assert_eq!(l[1], Listener { pid: 1967, process: String::new(), addr: "127.0.0.1".into(), port: 25057 });
        assert_eq!(l[2].pid, 4242);
        assert_eq!(l[3].pid, 5151);
    }

    #[test]
    fn ps_gives_short_names_and_parents() {
        let p = parse_ps(PS);
        assert_eq!(p[&4242], Proc { ppid: 100, name: "node".into() });
        assert_eq!(p[&1967].name, "Cursor Helper (Plugin)");
    }

    #[test]
    fn attributes_listener_to_session_via_ancestry_and_flags_conflicts() {
        let procs = parse_ps(PS);
        let sessions: HashMap<u32, String> = [(100u32, "proj:t1".to_string())].into();
        let rows = build_rows(parse_netstat(NETSTAT), &procs, &sessions);
        let node = rows.iter().find(|r| r.pid == 4242).unwrap();
        assert_eq!(node.session_id.as_deref(), Some("proj:t1"));
        assert_eq!(node.process, "node");
        assert!(node.conflict);
        let py = rows.iter().find(|r| r.pid == 5151).unwrap();
        assert_eq!(py.session_id, None);
        assert!(py.conflict);
        let cursor = rows.iter().find(|r| r.pid == 1967).unwrap();
        assert!(!cursor.conflict);
        assert_eq!(cursor.process, "Cursor Helper (Plugin)");
        assert_eq!(activity(&procs, &sessions).get("proj:t1"), Some(&1));
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m \x1b]0;title\x07x\r\n"), "ok x\r\n");
    }

    #[test]
    fn detects_agent_processes_under_a_session_shell() {
        let procs = parse_ps("1 0 launchd\n100 1 /bin/zsh\n200 100 claude\n300 200 node\n400 1 /bin/zsh\n500 400 /usr/bin/vim\n");
        let sessions: HashMap<u32, String> = [(100u32, "a:t".to_string()), (400u32, "b:t".to_string())].into();
        let a = agents(&procs, &sessions);
        assert_eq!(a.get("a:t").map(String::as_str), Some("claude"));
        assert_eq!(a.get("b:t"), None);
    }
}
