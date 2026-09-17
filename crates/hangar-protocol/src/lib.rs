//! Wire types shared by the Hangar app and the `hangar --daemon` session daemon.
//! Transport: one JSON object per line over a Unix domain socket. Binary payloads
//! (terminal bytes) are base64.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Client -> daemon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req: Option<u64>,
    #[serde(flatten)]
    pub cmd: Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Ping,
    List,
    Create {
        id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_command: Option<String>,
    },
    Scrollback {
        id: String,
        /// Return at most this many trailing bytes (default: daemon's replay cap).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<usize>,
    },
    Write { id: String, data: String },
    Resize { id: String, cols: u16, rows: u16 },
    Kill { id: String },
    Forget { id: String },
    /// Kill every session and exit the daemon (used when a newer Hangar build replaces it).
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: String,
    pub pid: u32,
    pub alive: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

/// Daemon -> client, in answer to a request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req: Option<u64>,
    #[serde(flatten)]
    pub body: ReplyBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum ReplyBody {
    Pong {
        version: u32,
        #[serde(default)]
        build: String,
    },
    Sessions { sessions: Vec<SessionInfo> },
    Created { id: String, pid: u32 },
    Scrollback { id: String, data: String },
    Ok,
    Error { message: String },
}

/// Daemon -> client, unsolicited.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Output { id: String, data: String },
    Exit { id: String, code: Option<i32> },
    /// The client fell behind and output was dropped; it should reload scrollback.
    Resync { id: String },
}

/// Anything the daemon can send.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ServerMessage {
    Reply(Reply),
    Event(Event),
}

/// Session ids are `<project-uuid>:<terminal-id>`. Only these characters are allowed.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

/// Injective file stem for a (valid) session id: `:` becomes `__`, `_` becomes `_u`.
pub fn session_file_stem(id: &str) -> String {
    let mut out = String::with_capacity(id.len() + 4);
    for c in id.chars() {
        match c {
            ':' => out.push_str("__"),
            '_' => out.push_str("_u"),
            c if c.is_ascii_alphanumeric() || c == '-' => out.push(c),
            _ => out.push_str("_x"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_with_flattened_cmd() {
        let r = Request {
            req: Some(7),
            cmd: Cmd::Create {
                id: "p1:claude".into(),
                cwd: "/tmp".into(),
                cols: 80,
                rows: 24,
                initial_command: Some("claude".into()),
            },
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"cmd\":\"create\""));
        assert!(s.contains("\"req\":7"));
        let back: Request = serde_json::from_str(&s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn server_message_distinguishes_reply_and_event() {
        let m: ServerMessage =
            serde_json::from_str(r#"{"event":"output","id":"x","data":"aGk="}"#).unwrap();
        assert!(matches!(m, ServerMessage::Event(Event::Output { .. })));
        let m: ServerMessage = serde_json::from_str(r#"{"req":3,"reply":"ok"}"#).unwrap();
        assert!(matches!(
            m,
            ServerMessage::Reply(Reply { req: Some(3), body: ReplyBody::Ok })
        ));
        let m: ServerMessage = serde_json::from_str(r#"{"reply":"pong","version":1}"#).unwrap();
        assert!(matches!(m, ServerMessage::Reply(Reply { body: ReplyBody::Pong { version: 1, .. }, .. })));
    }

    #[test]
    fn session_file_stem_is_injective() {
        assert_eq!(session_file_stem("abc-123:claude"), "abc-123__claude");
        assert_ne!(session_file_stem("a:b"), session_file_stem("a_b"));
        assert!(valid_session_id("p-1:t2"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("a/b"));
    }
}
