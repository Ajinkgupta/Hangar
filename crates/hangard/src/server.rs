//! Unix-socket server: NDJSON requests in, replies + broadcast events out.

use crate::session::{b64, log_path, unb64, Session};
use anyhow::{Context, Result};
use hangar_protocol::{valid_session_id, Cmd, Event, Reply, ReplyBody, Request, PROTOCOL_VERSION};
use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

/// Replay at most this much scrollback to a client (the full 2 MB lives on disk).
pub const REPLAY_CAP: usize = 512 * 1024;
/// A request line longer than this is rejected instead of buffered.
const MAX_LINE: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct Daemon {
    data_dir: PathBuf,
    sessions: Sessions,
    events: broadcast::Sender<Event>,
    build: String,
    shutting_down: Arc<AtomicBool>,
}

fn lock_sessions(s: &Sessions) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

impl Daemon {
    pub fn new(data_dir: &Path, build: &str) -> Self {
        // Small ring: back-pressure engages at a few MB, and a lagging client gets a
        // Resync event instead of silently missing output.
        let (events, _) = broadcast::channel(512);
        Self {
            data_dir: data_dir.to_path_buf(),
            sessions: Default::default(),
            events,
            build: build.to_string(),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn handle(&self, req: Request) -> Reply {
        let body = match self.dispatch(req.cmd) {
            Ok(b) => b,
            Err(e) => ReplyBody::Error { message: e.to_string() },
        };
        Reply { req: req.req, body }
    }

    fn dispatch(&self, cmd: Cmd) -> Result<ReplyBody> {
        if self.shutting_down.load(Ordering::SeqCst) && !matches!(cmd, Cmd::Ping | Cmd::List) {
            anyhow::bail!("daemon is shutting down");
        }
        match cmd {
            Cmd::Ping => Ok(ReplyBody::Pong { version: PROTOCOL_VERSION, build: self.build.clone() }),
            Cmd::Shutdown => {
                self.shutting_down.store(true, Ordering::SeqCst);
                let all: Vec<Session> = lock_sessions(&self.sessions).drain().map(|(_, s)| s).collect();
                let handles: Vec<_> = all.into_iter().map(|s| std::thread::spawn(move || s.kill())).collect();
                for h in handles {
                    let _ = h.join();
                }
                let _ = std::fs::remove_file(crate::socket_path(&self.data_dir));
                let _ = std::fs::remove_file(self.data_dir.join("hangard.pid"));
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    std::process::exit(0);
                });
                Ok(ReplyBody::Ok)
            }
            Cmd::List => {
                let s = lock_sessions(&self.sessions);
                Ok(ReplyBody::Sessions { sessions: s.values().map(|x| x.info()).collect() })
            }
            Cmd::Create { id, cwd, cols, rows, initial_command } => {
                if !valid_session_id(&id) {
                    anyhow::bail!("invalid session id");
                }
                let mut s = lock_sessions(&self.sessions);
                if let Some(existing) = s.get(&id) {
                    if existing.is_alive() {
                        return Ok(ReplyBody::Created { id, pid: existing.pid });
                    }
                    s.remove(&id);
                }
                let sess = Session::spawn(&self.data_dir, &id, &cwd, cols.max(2), rows.max(1), initial_command, self.events.clone())?;
                let pid = sess.pid;
                s.insert(id.clone(), sess);
                Ok(ReplyBody::Created { id, pid })
            }
            Cmd::Scrollback { id, max_bytes } => {
                let cap = max_bytes.unwrap_or(REPLAY_CAP).min(REPLAY_CAP);
                let live = lock_sessions(&self.sessions).get(&id).map(|sess| sess.scrollback_tail(cap));
                let data = match live {
                    Some(d) => d,
                    // Not running: serve the on-disk tail so the UI can still show history.
                    None => read_tail(&log_path(&self.data_dir, &id), cap),
                };
                Ok(ReplyBody::Scrollback { id, data: b64(&data) })
            }
            Cmd::Write { id, data } => {
                let bytes = unb64(&data)?;
                let s = lock_sessions(&self.sessions);
                let sess = s.get(&id).context("no such session")?;
                sess.write(&bytes)?; // non-blocking: queued to the session's writer thread
                Ok(ReplyBody::Ok)
            }
            Cmd::Resize { id, cols, rows } => {
                let s = lock_sessions(&self.sessions);
                let sess = s.get(&id).context("no such session")?;
                sess.resize(cols.max(2), rows.max(1))?;
                Ok(ReplyBody::Ok)
            }
            Cmd::Kill { id } => {
                let sess = lock_sessions(&self.sessions).remove(&id);
                if let Some(sess) = sess {
                    sess.kill();
                }
                Ok(ReplyBody::Ok)
            }
            Cmd::Forget { id } => {
                let sess = lock_sessions(&self.sessions).remove(&id);
                if let Some(sess) = sess {
                    sess.kill();
                }
                if valid_session_id(&id) {
                    let _ = std::fs::remove_file(log_path(&self.data_dir, &id));
                }
                Ok(ReplyBody::Ok)
            }
        }
    }
}

fn read_tail(path: &Path, cap: usize) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(cap as u64)));
    let mut v = Vec::new();
    let _ = f.read_to_end(&mut v);
    v
}

/// Blocking: binds the socket under `data_dir` and serves forever.
pub fn run(data_dir: &Path, build: &str) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let _ = std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700));
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(serve(data_dir, crate::socket_path(data_dir), build))
}

/// Exclusive daemon lock for `data_dir`; held for the process lifetime.
fn acquire_lock(data_dir: &Path) -> Result<File> {
    use std::os::unix::io::AsRawFd;
    let lock = std::fs::OpenOptions::new().create(true).write(true).open(data_dir.join("hangard.lock"))?;
    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        anyhow::bail!("another hangar daemon already owns {}", data_dir.display());
    }
    Ok(lock)
}

pub async fn serve(data_dir: &Path, sock: PathBuf, build: &str) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    // Only one daemon per data dir: a second start exits instead of stealing the socket.
    let _lock = acquire_lock(data_dir)?;
    if let Some(parent) = sock.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).with_context(|| format!("bind {}", sock.display()))?;
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    if let Err(e) = std::fs::write(data_dir.join("hangard.pid"), std::process::id().to_string()) {
        eprintln!("pid file not written: {e}");
    }
    let daemon = Daemon::new(data_dir, build);
    eprintln!("hangard {build} listening on {}", sock.display());
    let me = unsafe { libc::geteuid() };
    loop {
        let (stream, _) = listener.accept().await?;
        // Belt and braces with the 0600 socket: refuse other users.
        match stream.peer_cred() {
            Ok(c) if c.uid() == me => {}
            _ => continue,
        }
        let d = daemon.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(d, stream).await {
                eprintln!("client error: {e:#}");
            }
        });
    }
}

async fn handle_client(daemon: Daemon, stream: UnixStream) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(256);

    // Writer task: serialises everything going to this client.
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // Event forwarder. Consecutive output for the same session is coalesced, and if we
    // fall behind the broadcast ring the client is told to resync that session.
    let mut events = daemon.events.subscribe();
    let etx = tx.clone();
    let forwarder = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    let line = serde_json::to_string(&ev).unwrap();
                    if etx.send(line).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let line = serde_json::to_string(&Event::Resync { id: "*".into() }).unwrap();
                    if etx.send(line).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut reader = BufReader::with_capacity(64 * 1024, rd);
    let mut line = String::new();
    loop {
        line.clear();
        let n = match (&mut reader).take(MAX_LINE as u64 + 1).read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if n > MAX_LINE {
            let _ = tx.send(serde_json::to_string(&Reply { req: None, body: ReplyBody::Error { message: "request too large".into() } })?).await;
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => {
                let d = daemon.clone();
                match tokio::task::spawn_blocking(move || d.handle(req)).await {
                    Ok(r) => r,
                    Err(e) => Reply { req: None, body: ReplyBody::Error { message: format!("internal error: {e}") } },
                }
            }
            Err(e) => Reply { req: None, body: ReplyBody::Error { message: format!("bad request: {e}") } },
        };
        if tx.send(serde_json::to_string(&reply)?).await.is_err() {
            break;
        }
    }
    forwarder.abort();
    drop(tx);
    let _ = writer.await;
    Ok(())
}
