use hangar_protocol::*;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

struct Client {
    lines: tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    wr: tokio::net::unix::OwnedWriteHalf,
    next: u64,
}

impl Client {
    async fn connect(sock: &std::path::Path) -> Client {
        let mut last = None;
        for _ in 0..50 {
            match UnixStream::connect(sock).await {
                Ok(s) => {
                    let (rd, wr) = s.into_split();
                    return Client { lines: BufReader::new(rd).lines(), wr, next: 1 };
                }
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("connect: {last:?}");
    }
    async fn send(&mut self, cmd: Cmd) -> u64 {
        let req = self.next;
        self.next += 1;
        let s = serde_json::to_string(&Request { req: Some(req), cmd }).unwrap();
        self.wr.write_all(format!("{s}\n").as_bytes()).await.unwrap();
        req
    }
    async fn next_msg(&mut self) -> ServerMessage {
        let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
            .await.expect("timeout").unwrap().expect("eof");
        serde_json::from_str(&line).unwrap()
    }
    async fn reply(&mut self, req: u64) -> ReplyBody {
        loop {
            if let ServerMessage::Reply(r) = self.next_msg().await {
                if r.req == Some(req) { return r.body; }
            }
        }
    }
    async fn wait_output_containing(&mut self, needle: &str) -> String {
        let mut acc = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            if let ServerMessage::Event(Event::Output { data, .. }) = self.next_msg().await {
                acc.push_str(&String::from_utf8_lossy(&hangard::session::unb64(&data).unwrap()));
                if acc.contains(needle) { return acc; }
            }
        }
        panic!("never saw {needle:?}; got {acc:?}");
    }
}

fn decode(b: &str) -> String {
    String::from_utf8_lossy(&hangard::session::unb64(b).unwrap()).to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn create_write_scrollback_kill_and_restart_keeps_history() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let sock = std::path::PathBuf::from(format!("/tmp/hangard-test-{}.sock", std::process::id()));

    let d1 = { let (data, sock) = (data.clone(), sock.clone());
        tokio::spawn(async move { hangard::server::serve(&data, sock, "test").await.unwrap() }) };
    let mut c = Client::connect(&sock).await;

    let r = c.send(Cmd::Ping).await;
    assert!(matches!(c.reply(r).await, ReplyBody::Pong { version: 1, .. }));

    let r = c.send(Cmd::Create { id: "p:shell".into(), cwd: "/tmp".into(), cols: 80, rows: 24,
        initial_command: Some("echo hangar-ok-$((20+22))".into()) }).await;
    let ReplyBody::Created { pid, .. } = c.reply(r).await else { panic!() };
    assert!(pid > 0);
    c.wait_output_containing("hangar-ok-42").await;

    let r = c.send(Cmd::Write { id: "p:shell".into(), data: hangard::session::b64(b"echo second-line\r") }).await;
    assert!(matches!(c.reply(r).await, ReplyBody::Ok));
    c.wait_output_containing("second-line").await;

    let r = c.send(Cmd::Scrollback { id: "p:shell".into() }).await;
    let ReplyBody::Scrollback { data: sb, .. } = c.reply(r).await else { panic!() };
    let text = decode(&sb);
    assert!(text.contains("hangar-ok-42") && text.contains("second-line"));

    let r = c.send(Cmd::List).await;
    let ReplyBody::Sessions { sessions } = c.reply(r).await else { panic!() };
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].alive);

    let r = c.send(Cmd::Kill { id: "p:shell".into() }).await;
    assert!(matches!(c.reply(r).await, ReplyBody::Ok));
    let r = c.send(Cmd::List).await;
    let ReplyBody::Sessions { sessions } = c.reply(r).await else { panic!() };
    assert!(sessions.is_empty());

    // Restart the daemon: history must come back from disk with the marker.
    d1.abort();
    let _ = std::fs::remove_file(&sock);
    let _d2 = { let (data, sock) = (data.clone(), sock.clone());
        tokio::spawn(async move { hangard::server::serve(&data, sock, "test").await.unwrap() }) };
    let mut c = Client::connect(&sock).await;
    let r = c.send(Cmd::Create { id: "p:shell".into(), cwd: "/tmp".into(), cols: 80, rows: 24, initial_command: None }).await;
    assert!(matches!(c.reply(r).await, ReplyBody::Created { .. }));
    let r = c.send(Cmd::Scrollback { id: "p:shell".into() }).await;
    let ReplyBody::Scrollback { data: sb, .. } = c.reply(r).await else { panic!() };
    let text = decode(&sb);
    assert!(text.contains("hangar-ok-42"), "old output missing");
    assert!(text.contains("previous session ended"), "marker missing");

    let r = c.send(Cmd::Forget { id: "p:shell".into() }).await;
    assert!(matches!(c.reply(r).await, ReplyBody::Ok));
    assert!(!hangard::session::log_path(&data, "p:shell").exists());
    let _ = std::fs::remove_file(&sock);
}
