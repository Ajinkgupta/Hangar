//! Persistent connection to `hangar --daemon`; spawns it when absent and reconnects.

use hangar_protocol::{Cmd, Event, ReplyBody, Request, ServerMessage};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<ReplyBody>>>>;

struct Conn {
    tx: mpsc::Sender<String>,
    pending: Pending,
}

#[derive(Default)]
pub struct DaemonState {
    conn: Arc<Mutex<Option<Conn>>>,
    next_req: AtomicU64,
}

#[derive(Serialize, Clone)]
struct OutputPayload {
    id: String,
    data: String,
}
#[derive(Serialize, Clone)]
struct BellPayload {
    id: String,
}
#[derive(Serialize, Clone)]
struct DaemonBuild {
    stale: bool,
    build: String,
}
#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

fn spawn_daemon(data_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let exe = std::env::current_exe()?;
    let log = OpenOptions::new().create(true).append(true).open(data_dir.join("hangard.log"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--daemon")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .env("HANGAR_DATA_DIR", data_dir);
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()?;
    Ok(())
}

async fn connect_or_spawn(data_dir: &Path) -> anyhow::Result<UnixStream> {
    let sock = hangard::socket_path(data_dir);
    if let Ok(s) = UnixStream::connect(&sock).await {
        return Ok(s);
    }
    let _ = std::fs::remove_file(&sock);
    spawn_daemon(data_dir)?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Ok(s) = UnixStream::connect(&sock).await {
            return Ok(s);
        }
    }
    anyhow::bail!("daemon did not come up at {}", sock.display())
}

/// Runs forever: keeps the app connected to the daemon, forwarding events to the UI.
pub async fn start(app: AppHandle) {
    let data_dir = hangard::default_data_dir();
    let state = app.state::<DaemonState>();
    let conn_slot = state.conn.clone();
    loop {
        match connect_or_spawn(&data_dir).await {
            Ok(stream) => {
                let (rd, mut wr) = stream.into_split();
                let (tx, mut rx) = mpsc::channel::<String>(4096);
                let pending: Pending = Default::default();
                *conn_slot.lock().unwrap() = Some(Conn { tx, pending: pending.clone() });
                let _ = app.emit("daemon:connected", ());
                // Handshake: tell the UI if this daemon comes from a different Hangar build.
                {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let st = app.state::<DaemonState>();
                        if let Ok(ReplyBody::Pong { build, .. }) = st.request(Cmd::Ping).await {
                            let _ = app.emit("daemon:build", DaemonBuild { stale: build != env!("HANGAR_BUILD_ID"), build });
                        }
                    });
                }

                let writer = tokio::spawn(async move {
                    while let Some(line) = rx.recv().await {
                        if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                            break;
                        }
                    }
                });

                let mut lines = BufReader::new(rd).lines();
                // Terminal output is coalesced per session for up to FLUSH_WINDOW (or
                // FLUSH_BYTES) so a chatty program costs a few IPC events per frame, not
                // one per PTY read.
                const FLUSH_WINDOW: Duration = Duration::from_millis(4);
                const FLUSH_BYTES: usize = 64 * 1024;
                let mut pending_out: Vec<(String, Vec<u8>)> = Vec::new();
                let mut pending_bytes = 0usize;
                let flush = |pending_out: &mut Vec<(String, Vec<u8>)>, pending_bytes: &mut usize| {
                    use base64::Engine;
                    for (id, bytes) in pending_out.drain(..) {
                        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let _ = app.emit("pty:output", OutputPayload { id, data });
                    }
                    *pending_bytes = 0;
                };
                loop {
                    let next = if pending_out.is_empty() {
                        lines.next_line().await
                    } else {
                        match tokio::time::timeout(FLUSH_WINDOW, lines.next_line()).await {
                            Ok(r) => r,
                            Err(_) => {
                                flush(&mut pending_out, &mut pending_bytes);
                                continue;
                            }
                        }
                    };
                    let line = match next {
                        Ok(Some(l)) => l,
                        _ => break,
                    };
                    match serde_json::from_str::<ServerMessage>(&line) {
                        Ok(ServerMessage::Event(Event::Output { id, data })) => {
                            use base64::Engine;
                            let bytes = base64::engine::general_purpose::STANDARD.decode(&data).unwrap_or_default();
                            if bytes.contains(&0x07) {
                                let _ = app.emit("pty:bell", BellPayload { id: id.clone() });
                            }
                            pending_bytes += bytes.len();
                            match pending_out.iter_mut().find(|(i, _)| *i == id) {
                                Some((_, buf)) => buf.extend_from_slice(&bytes),
                                None => pending_out.push((id, bytes)),
                            }
                            if pending_bytes >= FLUSH_BYTES {
                                flush(&mut pending_out, &mut pending_bytes);
                            }
                        }
                        Ok(ServerMessage::Event(Event::Exit { id, code })) => {
                            flush(&mut pending_out, &mut pending_bytes);
                            let _ = app.emit("pty:exit", ExitPayload { id, code });
                        }
                        Ok(ServerMessage::Reply(r)) => {
                            if let Some(req) = r.req {
                                if let Some(tx) = pending.lock().unwrap().remove(&req) {
                                    let _ = tx.send(r.body);
                                }
                            }
                        }
                        Err(e) => eprintln!("bad daemon message: {e}: {line}"),
                    }
                }
                flush(&mut pending_out, &mut pending_bytes);
                writer.abort();
                *conn_slot.lock().unwrap() = None;
                pending.lock().unwrap().clear();
                let _ = app.emit("daemon:disconnected", ());
            }
            Err(e) => {
                eprintln!("daemon connect failed: {e:#}");
                let _ = app.emit("daemon:disconnected", ());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

impl DaemonState {
    pub async fn request(&self, cmd: Cmd) -> Result<ReplyBody, String> {
        let req = self.next_req.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        let sender = {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or("session daemon not connected")?;
            conn.pending.lock().unwrap().insert(req, tx);
            conn.tx.clone()
        };
        let line = serde_json::to_string(&Request { req: Some(req), cmd }).map_err(|e| e.to_string())?;
        sender.send(line).await.map_err(|_| "daemon connection closed".to_string())?;
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(ReplyBody::Error { message })) => Err(message),
            Ok(Ok(body)) => Ok(body),
            Ok(Err(_)) => Err("daemon connection dropped".into()),
            Err(_) => Err("daemon request timed out".into()),
        }
    }

    /// Sends a request without waiting for a reply. Used for terminal input: it is
    /// called from a sync command on the main thread, so keystrokes keep their order.
    pub fn send_nowait(&self, cmd: Cmd) -> Result<(), String> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("session daemon not connected")?;
        let line = serde_json::to_string(&Request { req: None, cmd }).map_err(|e| e.to_string())?;
        conn.tx.try_send(line).map_err(|_| "daemon connection busy".to_string())
    }

    pub fn is_connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }
}

#[tauri::command]
pub fn daemon_status(state: State<'_, DaemonState>) -> bool {
    state.is_connected()
}

/// Asks the (old) daemon to exit; the reconnect loop then spawns this build's daemon.
#[tauri::command]
pub async fn daemon_restart(state: State<'_, DaemonState>) -> Result<(), String> {
    state.request(Cmd::Shutdown).await.map(|_| ())
}

#[tauri::command]
pub async fn pty_list(state: State<'_, DaemonState>) -> Result<Vec<hangar_protocol::SessionInfo>, String> {
    match state.request(Cmd::List).await? {
        ReplyBody::Sessions { sessions } => Ok(sessions),
        other => Err(format!("unexpected reply {other:?}")),
    }
}

#[tauri::command]
pub async fn pty_create(
    state: State<'_, DaemonState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    initial_command: Option<String>,
) -> Result<u32, String> {
    match state.request(Cmd::Create { id, cwd, cols, rows, initial_command }).await? {
        ReplyBody::Created { pid, .. } => Ok(pid),
        other => Err(format!("unexpected reply {other:?}")),
    }
}

/// Last `lines` lines of a session's scrollback as plain text (ANSI stripped).
#[tauri::command]
pub async fn pty_tail(state: State<'_, DaemonState>, id: String, lines: usize) -> Result<Vec<String>, String> {
    let data = match state.request(Cmd::Scrollback { id }).await? {
        ReplyBody::Scrollback { data, .. } => data,
        other => return Err(format!("unexpected reply {other:?}")),
    };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let start = bytes.len().saturating_sub(64 * 1024);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let plain = crate::monitor::strip_ansi(&text);
    let mut out: Vec<String> = plain
        .split(['\n', '\r'])
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    let keep = out.len().saturating_sub(lines);
    out.drain(..keep);
    Ok(out)
}

#[tauri::command]
pub async fn pty_scrollback(state: State<'_, DaemonState>, id: String) -> Result<String, String> {
    match state.request(Cmd::Scrollback { id }).await? {
        ReplyBody::Scrollback { data, .. } => Ok(data),
        other => Err(format!("unexpected reply {other:?}")),
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, DaemonState>, id: String, data: String) -> Result<(), String> {
    state.send_nowait(Cmd::Write { id, data })
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, DaemonState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.request(Cmd::Resize { id, cols, rows }).await.map(|_| ())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, DaemonState>, id: String) -> Result<(), String> {
    state.request(Cmd::Kill { id }).await.map(|_| ())
}

#[tauri::command]
pub async fn pty_forget(state: State<'_, DaemonState>, id: String) -> Result<(), String> {
    state.request(Cmd::Forget { id }).await.map(|_| ())
}
