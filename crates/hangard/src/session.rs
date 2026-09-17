//! One PTY-backed session: spawn, pump output to subscribers + scrollback, kill.

use crate::ringbuf::RingBuf;
use anyhow::{Context, Result};
use hangar_protocol::{session_file_stem, Event, SessionInfo};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

pub const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;
const LOG_ROTATE_AT: u64 = 4 * 1024 * 1024;
const LOG_KEEP: u64 = 2 * 1024 * 1024;
/// Called only every `ROTATE_CHECK_EVERY` bytes to keep syscalls off the hot path.
const ROTATE_CHECK_EVERY: usize = 256 * 1024;
/// Queued input per session before `write` reports a backlog (a stopped foreground
/// process that doesn't read stdin must not stall the daemon).
const INPUT_QUEUE: usize = 256;
pub const SESSION_ENDED_MARKER: &str =
    "\r\n\x1b[2m[hangar: previous session ended \u{2014} new session started]\x1b[0m\r\n";

#[derive(Clone)]
pub struct Shared {
    pub scrollback: Arc<Mutex<RingBuf>>,
    pub state: Arc<Mutex<State>>,
    /// Set once the output pump has hit EOF (every slave fd closed).
    pub pump_done: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct State {
    pub alive: bool,
    pub exit_code: Option<i32>,
}

pub struct Session {
    pub id: String,
    pub cwd: String,
    pub pid: u32,
    pub shared: Shared,
    master: Box<dyn MasterPty + Send>,
    input: SyncSender<Vec<u8>>,
}

pub fn log_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("sessions").join(format!("{}.log", session_file_stem(id)))
}

/// Reads the tail of a previous run's log, if any, for prepending as scrollback.
fn load_previous_log(path: &Path) -> Vec<u8> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(SCROLLBACK_CAP as u64);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut v = Vec::new();
    let _ = f.read_to_end(&mut v);
    v
}

/// Keeps the last LOG_KEEP bytes once the log passes LOG_ROTATE_AT (via temp + rename,
/// so a failure mid-way never loses the whole log).
fn rotate_if_needed(path: &Path, file: &mut Option<File>) {
    let Some(f) = file.as_mut() else { return };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return };
    if len < LOG_ROTATE_AT {
        return;
    }
    let mut tail = Vec::new();
    if f.seek(SeekFrom::Start(len - LOG_KEEP)).is_err() || f.read_to_end(&mut tail).is_err() {
        return;
    }
    let tmp = path.with_extension("log.tmp");
    let ok = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut t| t.write_all(&tail))
        .and_then(|_| std::fs::rename(&tmp, path))
        .is_ok();
    if ok {
        *file = OpenOptions::new().append(true).read(true).open(path).ok();
    }
}

impl Session {
    /// Spawns `$SHELL -il` in `cwd`. If a log for this id exists it is loaded as
    /// scrollback with a marker line appended.
    pub fn spawn(
        data_dir: &Path,
        id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        initial_command: Option<String>,
        events: broadcast::Sender<Event>,
    ) -> Result<Session> {
        let lp = log_path(data_dir, id);
        // Disk is best-effort: a full disk or bad permissions must not block terminals.
        let mut log: Option<File> = std::fs::create_dir_all(lp.parent().unwrap())
            .ok()
            .and_then(|_| OpenOptions::new().create(true).append(true).read(true).mode(0o600).open(&lp).ok());
        if log.is_none() {
            eprintln!("session {id}: scrollback log unavailable at {}; running memory-only", lp.display());
        }

        let mut ring = RingBuf::new(SCROLLBACK_CAP);
        let prev = load_previous_log(&lp);
        if !prev.is_empty() {
            ring.push(&prev);
            ring.push(SESSION_ENDED_MARKER.as_bytes());
            if let Some(l) = log.as_mut() {
                let _ = l.write_all(SESSION_ENDED_MARKER.as_bytes());
            }
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let mut dir = if cwd == "~" || cwd.starts_with("~/") { cwd.replacen('~', &home, 1) } else { cwd.to_string() };
        if !Path::new(&dir).is_dir() {
            dir = home.clone();
        }
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-il");
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("HANGAR_SESSION", id);
        // Never leak a parent Claude Code / agent session into the user's shells: it would
        // make `claude` think it is a nested child session (transcripts off, etc.).
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy().to_string();
            if k.starts_with("CLAUDE_CODE") || k == "CLAUDECODE" || k.starts_with("CURSOR_") || k == "TERM_PROGRAM" || k == "TERM_PROGRAM_VERSION" {
                cmd.env_remove(&k);
            }
        }
        cmd.env("TERM_PROGRAM", "Hangar");
        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        drop(pair.slave);
        let pid = child.process_id().unwrap_or(0);

        let mut writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;

        let shared = Shared {
            scrollback: Arc::new(Mutex::new(ring)),
            state: Arc::new(Mutex::new(State { alive: true, exit_code: None })),
            pump_done: Arc::new(AtomicBool::new(false)),
        };

        // Input goes through a dedicated writer thread so a foreground process that stops
        // reading stdin blocks only this session's queue, never the daemon.
        let (input, input_rx) = sync_channel::<Vec<u8>>(INPUT_QUEUE);
        std::thread::spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        // Initial command: sent once the shell has printed something (its prompt),
        // or after 2s at the latest, so shell start-up can't flush it away.
        let pending = Arc::new(Mutex::new(initial_command));
        {
            let pending = pending.clone();
            let input = input.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                send_pending(&pending, &input);
            });
        }

        // Output pump.
        {
            let id = id.to_string();
            let shared = shared.clone();
            let events = events.clone();
            let input = input.clone();
            let pending = pending.clone();
            let lp = lp.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                let mut first = true;
                let mut since_check = 0usize;
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let chunk = &buf[..n];
                    shared.scrollback.lock().unwrap_or_else(|e| e.into_inner()).push(chunk);
                    if let Some(l) = log.as_mut() {
                        let _ = l.write_all(chunk);
                    }
                    since_check += n;
                    if since_check >= ROTATE_CHECK_EVERY {
                        since_check = 0;
                        rotate_if_needed(&lp, &mut log);
                    }
                    let _ = events.send(Event::Output { id: id.clone(), data: b64(chunk) });
                    if first {
                        first = false;
                        let pending = pending.clone();
                        let input = input.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(80));
                            send_pending(&pending, &input);
                        });
                    }
                }
                shared.pump_done.store(true, Ordering::SeqCst);
            });
        }

        // Exit watcher: publishes Exit only after the pump has drained (or 500 ms), so
        // the last bytes of output always arrive before the exit event.
        {
            let id = id.to_string();
            let shared = shared.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                let deadline = Instant::now() + Duration::from_millis(500);
                while !shared.pump_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                {
                    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    st.alive = false;
                    st.exit_code = code;
                }
                let _ = events.send(Event::Exit { id, code });
            });
        }

        Ok(Session { id: id.to_string(), cwd: cwd.to_string(), pid, shared, master: pair.master, input })
    }

    pub fn info(&self) -> SessionInfo {
        let st = self.shared.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        SessionInfo { id: self.id.clone(), cwd: self.cwd.clone(), pid: self.pid, alive: st.alive, exit_code: st.exit_code }
    }

    pub fn is_alive(&self) -> bool {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner()).alive
    }

    /// Queues input for the PTY; never blocks the caller.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        match self.input.try_send(bytes.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => anyhow::bail!("input backlog: the foreground process is not reading its input"),
            Err(TrySendError::Disconnected(_)) => anyhow::bail!("session input closed"),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).context("resize")
    }

    pub fn scrollback_tail(&self, n: usize) -> Vec<u8> {
        self.shared.scrollback.lock().unwrap_or_else(|e| e.into_inner()).tail(n)
    }

    /// Ends the session: SIGHUP the shell's process group and the foreground process
    /// group (a dev server that traps HUP still gets killed), then SIGKILL survivors.
    /// Never signals a pid that has already been reaped (pid reuse).
    pub fn kill(&self) {
        let fg = self.master.process_group_leader().filter(|p| *p > 1);
        let shell = if self.is_alive() && self.pid > 1 { Some(self.pid as i32) } else { None };
        let groups: Vec<i32> = shell.into_iter().chain(fg).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if groups.is_empty() {
            return;
        }
        for g in &groups {
            unsafe {
                libc::kill(-*g, libc::SIGHUP);
            }
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if self.shared.pump_done.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        for g in &groups {
            unsafe {
                libc::kill(-*g, libc::SIGKILL);
            }
        }
    }
}

fn send_pending(pending: &Arc<Mutex<Option<String>>>, input: &SyncSender<Vec<u8>>) {
    let cmd = pending.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(cmd) = cmd {
        let _ = input.try_send(format!("{}\r", cmd).into_bytes());
    }
}

pub fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.decode(s)?)
}
