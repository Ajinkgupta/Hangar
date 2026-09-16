//! One PTY-backed session: spawn, pump output to subscribers + scrollback, kill.

use crate::ringbuf::RingBuf;
use anyhow::{Context, Result};
use hangar_protocol::{session_file_stem, Event, SessionInfo};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

pub const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;
const LOG_ROTATE_AT: u64 = 4 * 1024 * 1024;
const LOG_KEEP: u64 = 2 * 1024 * 1024;
pub const SESSION_ENDED_MARKER: &str =
    "\r\n\x1b[2m[hangar: previous session ended \u{2014} new session started]\x1b[0m\r\n";

#[derive(Clone)]
pub struct Shared {
    pub scrollback: Arc<Mutex<RingBuf>>,
    pub state: Arc<Mutex<State>>,
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
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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

fn rotate_if_needed(path: &Path, file: &mut File) {
    let Ok(len) = file.metadata().map(|m| m.len()) else { return };
    if len < LOG_ROTATE_AT {
        return;
    }
    let mut tail = Vec::new();
    if file.seek(SeekFrom::Start(len - LOG_KEEP)).is_ok() {
        let _ = file.read_to_end(&mut tail);
    }
    if let Ok(mut f) = OpenOptions::new().write(true).truncate(true).open(path) {
        let _ = f.write_all(&tail);
        let _ = file.seek(SeekFrom::End(0));
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
        std::fs::create_dir_all(lp.parent().unwrap())?;

        let mut ring = RingBuf::new(SCROLLBACK_CAP);
        let prev = load_previous_log(&lp);
        let mut log = OpenOptions::new().create(true).append(true).read(true).open(&lp)?;
        if !prev.is_empty() {
            ring.push(&prev);
            ring.push(SESSION_ENDED_MARKER.as_bytes());
            log.write_all(SESSION_ENDED_MARKER.as_bytes())?;
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-il");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("HANGAR_SESSION", id);
        // Never leak a parent Claude Code / agent session into the user's shells: it would
        // make `claude` think it is a nested child session (transcripts off, etc.).
        for (k, _) in std::env::vars() {
            if k.starts_with("CLAUDE_CODE") || k == "CLAUDECODE" || k.starts_with("CURSOR_") || k == "TERM_PROGRAM" || k == "TERM_PROGRAM_VERSION" {
                cmd.env_remove(&k);
            }
        }
        cmd.env("TERM_PROGRAM", "Hangar");
        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        drop(pair.slave);
        let pid = child.process_id().unwrap_or(0);

        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer()?));
        let mut reader = pair.master.try_clone_reader()?;

        let shared = Shared {
            scrollback: Arc::new(Mutex::new(ring)),
            state: Arc::new(Mutex::new(State { alive: true, exit_code: None })),
        };

        // Initial command: sent once the shell has printed something (its prompt),
        // or after 2s at the latest, so shell start-up can't flush it away.
        let pending = Arc::new(Mutex::new(initial_command));
        {
            let pending = pending.clone();
            let writer = writer.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                send_pending(&pending, &writer);
            });
        }

        // Output pump.
        {
            let id = id.to_string();
            let shared = shared.clone();
            let events = events.clone();
            let writer = writer.clone();
            let pending = pending.clone();
            let lp = lp.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                let mut first = true;
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let chunk = &buf[..n];
                    shared.scrollback.lock().unwrap().push(chunk);
                    let _ = log.write_all(chunk);
                    rotate_if_needed(&lp, &mut log);
                    let _ = events.send(Event::Output {
                        id: id.clone(),
                        data: b64(chunk),
                    });
                    if first {
                        first = false;
                        let pending = pending.clone();
                        let writer = writer.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(80));
                            send_pending(&pending, &writer);
                        });
                    }
                }
            });
        }

        // Exit watcher.
        {
            let id = id.to_string();
            let shared = shared.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                {
                    let mut st = shared.state.lock().unwrap();
                    st.alive = false;
                    st.exit_code = code;
                }
                let _ = events.send(Event::Exit { id, code });
            });
        }

        Ok(Session {
            id: id.to_string(),
            cwd: cwd.to_string(),
            pid,
            shared,
            master: pair.master,
            writer,
        })
    }

    pub fn info(&self) -> SessionInfo {
        let st = self.shared.state.lock().unwrap().clone();
        SessionInfo {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            pid: self.pid,
            alive: st.alive,
            exit_code: st.exit_code,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.shared.state.lock().unwrap().alive
    }

    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("resize")
    }

    pub fn scrollback(&self) -> Vec<u8> {
        self.shared.scrollback.lock().unwrap().contents()
    }

    /// SIGHUP the shell's process group, then SIGKILL anything still alive.
    pub fn kill(&self) {
        if self.pid == 0 {
            return;
        }
        let pgid = -(self.pid as i32);
        unsafe {
            libc::kill(pgid, libc::SIGHUP);
            libc::kill(self.pid as i32, libc::SIGHUP);
        }
        for _ in 0..10 {
            if !self.is_alive() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(pgid, libc::SIGKILL);
            libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }
}

fn send_pending(pending: &Arc<Mutex<Option<String>>>, writer: &Arc<Mutex<Box<dyn Write + Send>>>) {
    let cmd = pending.lock().unwrap().take();
    if let Some(cmd) = cmd {
        let mut w = writer.lock().unwrap();
        let _ = w.write_all(format!("{}\r", cmd).as_bytes());
        let _ = w.flush();
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
