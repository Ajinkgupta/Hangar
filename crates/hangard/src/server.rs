//! Unix-socket server: NDJSON requests in, replies + broadcast events out.

use crate::session::{b64, log_path, unb64, Session};
use anyhow::{Context, Result};
use hangar_protocol::{Cmd, Event, Reply, ReplyBody, Request, PROTOCOL_VERSION};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[derive(Clone)]
pub struct Daemon {
    data_dir: PathBuf,
    sessions: Sessions,
    events: broadcast::Sender<Event>,
}

impl Daemon {
    pub fn new(data_dir: &Path) -> Self {
        let (events, _) = broadcast::channel(8192);
        Self { data_dir: data_dir.to_path_buf(), sessions: Default::default(), events }
    }

    pub fn handle(&self, req: Request) -> Reply {
        let body = match self.dispatch(req.cmd) {
            Ok(b) => b,
            Err(e) => ReplyBody::Error { message: e.to_string() },
        };
        Reply { req: req.req, body }
    }

    fn dispatch(&self, cmd: Cmd) -> Result<ReplyBody> {
        match cmd {
            Cmd::Ping => Ok(ReplyBody::Pong { version: PROTOCOL_VERSION }),
            Cmd::List => {
                let s = self.sessions.lock().unwrap();
                Ok(ReplyBody::Sessions { sessions: s.values().map(|x| x.info()).collect() })
            }
            Cmd::Create { id, cwd, cols, rows, initial_command } => {
                let mut s = self.sessions.lock().unwrap();
                if let Some(existing) = s.get(&id) {
                    if existing.is_alive() {
                        return Ok(ReplyBody::Created { id, pid: existing.pid });
                    }
                    s.remove(&id);
                }
                let sess = Session::spawn(
                    &self.data_dir,
                    &id,
                    &cwd,
                    cols.max(2),
                    rows.max(1),
                    initial_command,
                    self.events.clone(),
                )?;
                let pid = sess.pid;
                s.insert(id.clone(), sess);
                Ok(ReplyBody::Created { id, pid })
            }
            Cmd::Scrollback { id } => {
                let s = self.sessions.lock().unwrap();
                let data = match s.get(&id) {
                    Some(sess) => sess.scrollback(),
                    // Not running: serve the on-disk tail so the UI can still show history.
                    None => {
                        let p = log_path(&self.data_dir, &id);
                        std::fs::read(p).unwrap_or_default()
                    }
                };
                let tail = if data.len() > crate::session::SCROLLBACK_CAP {
                    &data[data.len() - crate::session::SCROLLBACK_CAP..]
                } else {
                    &data[..]
                };
                Ok(ReplyBody::Scrollback { id, data: b64(tail) })
            }
            Cmd::Write { id, data } => {
                let writer = {
                    let s = self.sessions.lock().unwrap();
                    s.get(&id).context("no such session")?.writer()
                };
                let bytes = unb64(&data)?;
                let mut w = writer.lock().unwrap();
                w.write_all(&bytes)?;
                w.flush()?;
                Ok(ReplyBody::Ok)
            }
            Cmd::Resize { id, cols, rows } => {
                let s = self.sessions.lock().unwrap();
                let sess = s.get(&id).context("no such session")?;
                sess.resize(cols.max(2), rows.max(1))?;
                Ok(ReplyBody::Ok)
            }
            Cmd::Kill { id } => {
                let sess = self.sessions.lock().unwrap().remove(&id);
                if let Some(sess) = sess {
                    sess.kill();
                }
                Ok(ReplyBody::Ok)
            }
            Cmd::Forget { id } => {
                let sess = self.sessions.lock().unwrap().remove(&id);
                if let Some(sess) = sess {
                    sess.kill();
                }
                let _ = std::fs::remove_file(log_path(&self.data_dir, &id));
                Ok(ReplyBody::Ok)
            }
        }
    }
}

/// Blocking: binds the socket under `data_dir` and serves forever.
pub fn run(data_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(serve(data_dir, crate::socket_path(data_dir)))
}

pub async fn serve(data_dir: &Path, sock: PathBuf) -> Result<()> {
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).with_context(|| format!("bind {}", sock.display()))?;
    std::fs::write(data_dir.join("hangard.pid"), std::process::id().to_string())?;
    let daemon = Daemon::new(data_dir);
    eprintln!("hangard listening on {}", sock.display());
    loop {
        let (stream, _) = listener.accept().await?;
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
    let (tx, mut rx) = mpsc::channel::<String>(4096);

    // Writer task: serialises everything going to this client.
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // Event forwarder.
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
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => {
                let d = daemon.clone();
                tokio::task::spawn_blocking(move || d.handle(req)).await?
            }
            Err(e) => Reply { req: None, body: ReplyBody::Error { message: format!("bad request: {e}") } },
        };
        tx.send(serde_json::to_string(&reply)?).await?;
    }
    forwarder.abort();
    drop(tx);
    let _ = writer.await;
    Ok(())
}
