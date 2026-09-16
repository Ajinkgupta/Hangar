//! Hangar session daemon: owns one PTY per session, keeps scrollback in memory and on
//! disk, and serves clients over a Unix socket using `hangar_protocol`.

pub mod ringbuf;
pub mod session;
pub mod server;

use std::path::PathBuf;

/// `~/Library/Application Support/hangar` (or `$HANGAR_DATA_DIR` when set).
pub fn default_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("HANGAR_DATA_DIR") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/hangar")
}

pub fn socket_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("hangard.sock")
}

/// Blocking entry point used by `hangar --daemon`.
pub fn run_default() -> anyhow::Result<()> {
    let data_dir = default_data_dir();
    server::run(&data_dir)
}
