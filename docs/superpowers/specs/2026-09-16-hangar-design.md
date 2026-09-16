# Hangar — Design Spec

Date: 2026-09-16
Status: approved direction (Tauri + Rust, background daemon for persistence)

## 1. Summary

Hangar is a local macOS app: one persistent terminal pair per project (a `claude`
PTY and a `shell` PTY), a live port/process monitor with one-click kill, and an
embedded WKWebView preview, all switchable from a sidebar. It does not edit code.

The PRD (see conversation, 2026-09-16) is the requirements source. This spec
records the architecture and the decisions needed to build it end-to-end.

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Shell | Tauri v2 (Rust backend, React + TypeScript + Vite frontend) | PRD choice; small binary, native WKWebView |
| PTY ownership | A background daemon process (`hangar --daemon`) that outlives the GUI | Required so quitting and relaunching Hangar reattaches to running sessions |
| Daemon packaging | Same binary as the app, selected by `--daemon` flag | No sidecar/target-triple packaging; app spawns `current_exe() --daemon` |
| App ↔ daemon transport | Unix domain socket, newline-delimited JSON, binary payloads base64 | Simple, debuggable, fast enough for local terminal traffic |
| Scrollback | In-memory ring buffer per session (2 MB) mirrored to an append-only file on disk | Survives GUI restart (memory) and daemon restart (disk) |
| Terminal renderer | xterm.js (+ fit, web-links addons) | Industry standard, full ANSI |
| Port data | `lsof -nP -iTCP -sTCP:LISTEN` + `ps -axo pid,ppid,comm` every 2 s while the app is visible | No deep OS APIs; PID→project attribution via process ancestry |
| Embedded browser | Tauri child webview (multi-webview, `unstable` feature) per project, shown/hidden, positioned over a placeholder div | Real WKWebView; iframes are blocked/mixed-content-fragile |
| Config | `~/Library/Application Support/hangar/config.json` | Fully local |
| Claude launch | `claude` typed into the claude PTY when the session is first created | PRD: auto-launch at add time; command is editable per project |

## 3. Process model

```
┌──────────────────────────────┐        unix socket         ┌─────────────────────────────┐
│ Hangar.app (Tauri)           │ ─────────────────────────▶ │ hangar --daemon (detached)  │
│  Rust: daemon_client, ports, │ ◀───────────────────────── │  sessions: PTY + ring buffer │
│        browser, config       │   NDJSON, b64 payloads     │  scrollback files on disk    │
│  Web:  React UI + xterm.js   │                            │  survives GUI quit           │
└──────────────────────────────┘                            └─────────────────────────────┘
```

- On launch the app connects to `<data_dir>/hangard.sock`. If the connect fails it
  removes a stale socket, spawns `current_exe() --daemon` fully detached (setsid,
  stdio to `<data_dir>/hangard.log`), and retries for up to 5 s.
- The daemon writes `<data_dir>/hangard.pid`. Only "stop session", the daemon being
  killed, or a reboot ends sessions. Quitting the GUI does not.
- `<data_dir>` = `~/Library/Application Support/hangar/`.

## 4. Daemon (`crates/hangard`)

### Responsibilities
- Spawn one PTY per session id using `portable-pty`: `$SHELL -il` (falls back to
  `/bin/zsh`) with `cwd` = project path, `TERM=xterm-256color`, `COLORTERM=truecolor`.
- Optional `initial_command`: written to the PTY as `"<cmd>\r"` immediately after
  spawn (the tty line discipline buffers it until the shell reads).
- Per session: reader thread pumps PTY output into (a) a 2 MB ring buffer,
  (b) an append-only file `<data_dir>/sessions/<id>.log`, (c) every connected client.
- On `create` for an id whose `.log` exists but no live session exists, the file
  (last 2 MB) is loaded into the ring buffer, then a dim marker line
  `[hangar: previous session ended — new session started]` is appended, then the PTY
  spawns. This is how scrollback survives a daemon restart.
- Log files are truncated to the last 2 MB when they exceed 4 MB.
- Serves multiple concurrent clients; each client receives all `output`/`exit` events.

### Protocol (one JSON object per line)

Client → daemon (`cmd`):
| cmd | fields | reply |
|---|---|---|
| `ping` | | `pong` |
| `list` | | `sessions: [{id, cwd, pid, alive, exit_code}]` |
| `create` | `id, cwd, cols, rows, initial_command?` | `created {id, pid}` (no-op + same reply if already alive) |
| `scrollback` | `id` | `scrollback {id, data(b64)}` |
| `write` | `id, data(b64)` | `ok` |
| `resize` | `id, cols, rows` | `ok` |
| `kill` | `id` | `ok` — SIGHUP the child, wait 500 ms, SIGKILL, drop session, keep the log file |
| `forget` | `id` | `ok` — kill + delete log file (used on project remove) |

Every request may carry `req` (u64) which is echoed on the reply. Errors:
`{"reply":"error","req":n,"message":"..."}`.

Daemon → client events: `{"event":"output","id","data"}`,
`{"event":"exit","id","code"}`.

Session ids are `<project-uuid>:claude` / `<project-uuid>:shell`; file names replace
`:` with `_`.

## 5. Tauri backend (`src-tauri`)

Modules and commands (all `#[tauri::command]`, async where they hit the socket):

- **daemon_client** — single persistent connection; reader task forwards events as
  Tauri events `pty:output {id,data}` and `pty:exit {id,code}`. Reconnects (and
  respawns the daemon) if the connection drops. Commands: `pty_list`, `pty_create`,
  `pty_scrollback`, `pty_write`, `pty_resize`, `pty_kill`, `pty_forget`.
- **monitor** — `monitor_tick(session_pids: {sessionId: pid})` returns
  `{ports: [PortRow], activity: {sessionId: child_process_count}}`.
  - `PortRow {port, proto, addr, pid, process, session_id?, conflict: bool}`
  - Attribution: build the `ps` parent map; a listener belongs to the session whose
    shell PID is an ancestor of the listener PID.
  - `conflict` = more than one distinct PID listening on the same port.
  - Entries are de-duplicated per (port, pid) (IPv4 + IPv6 listeners of one process
    collapse into one row).
  - `kill_process(pid, force)` → SIGTERM, or SIGKILL when `force`.
- **browser** — one child webview per project, label `browser-<uuid>`, created lazily.
  `browser_show(project_id, url, rect)`, `browser_hide(project_id)`,
  `browser_navigate(project_id, url)`, `browser_back/forward/reload(project_id)`
  (via `eval` of `history.back()` etc.), `browser_set_bounds(project_id, rect)`,
  `browser_destroy(project_id)`. Emits `browser:navigated {project_id, url}` from the
  webview `on_navigation`/page-load hooks so the address bar tracks redirects.
  Window layout: a `Window` with two kinds of children — `ui` (the React app,
  `auto_resize`) and the browser webviews positioned by the frontend.
- **config** — `config_load() -> serde_json::Value`, `config_save(value)`; atomic
  write (temp file + rename). Schema owned by the frontend (below).
- **dialog** — folder picker via `tauri-plugin-dialog`.

## 6. Frontend (`src/`)

Stack: React 18, TypeScript, Vite, zustand, xterm.js, react-resizable-panels,
@dnd-kit for sidebar reorder.

### Config schema (`config.json`, version 1)
```ts
type Config = {
  version: 1;
  projects: Project[];          // order = sidebar order
  activeProjectId: string | null;
};
type Project = {
  id: string;                   // uuid
  name: string;                 // defaults to folder basename, editable later
  path: string;
  claudeCommand: string;        // default "claude"
  commands: { id: string; label: string; command: string }[];
  layout: {
    activeTab: "claude" | "shell";
    browserOpen: boolean;
    splitDirection: "horizontal" | "vertical";   // browser beside / below terminal
    splitRatio: number;                          // 0.2–0.8, terminal share
    portsOpen: boolean;
    browserUrl: string | null;                   // last manual/auto URL
  };
};
```
Defaults: commands `[]`, layout `{activeTab:"claude", browserOpen:false,
splitDirection:"horizontal", splitRatio:0.6, portsOpen:true, browserUrl:null}`.
Saves are debounced 300 ms; every mutation goes through the store.

### Components
- **Sidebar** — project list (drag to reorder, right-click → Rename / Stop sessions /
  Remove), "+ Add project" (folder picker or paste-path input). Status dot per project.
- **ProjectView** — for the active project: tab strip (`claude` | `shell`),
  SavedCommandsBar, split layout of TerminalPane and BrowserPane, PortsPanel toggle.
- **TerminalPane** — one xterm instance per session, all kept mounted (hidden via
  `display:none` when inactive) so switching is instant; `fit()` on show/resize;
  resize → `pty_resize`. On first mount: `pty_create` (idempotent) then
  `pty_scrollback` written into the terminal before live output is applied
  (events arriving during the fetch are queued).
- **SavedCommandsBar** — buttons that `pty_write` `<command>\r` to the shell session and
  switch the active tab to `shell`; "Edit" opens an inline list editor (add/edit/remove).
- **PortsPanel** — table: port, process, PID, project/session; toggle "Hangar projects"
  / "All"; conflict rows highlighted; Kill button (Kill → confirm-free SIGTERM;
  a second click within 5 s while still alive sends SIGKILL). Polls `monitor_tick`
  every 2 s while the window is focused/visible.
- **BrowserPane** — toolbar (back, forward, reload, address input, split-direction
  toggle, close) and a placeholder div; a `ResizeObserver` on the div drives
  `browser_set_bounds`. Address defaults to `http://localhost:<lowest port owned by
  the project>` when the pane opens with no saved URL; a "Use :PORT" hint appears when a
  new project port shows up.

### Status dot rules (computed every monitor tick)
- **error** (red): a session of the project has exited and not been restarted.
- **running** (green): any session of the project has ≥1 child process under its shell,
  or the project owns a listening port.
- **idle** (grey): otherwise.

### Project lifecycle
- Add: pick folder → create Project with defaults → `pty_create` both sessions,
  claude session with `initial_command = claudeCommand` → select it.
- Stop sessions: `pty_kill` both; terminals show an "ended" banner with a Restart button
  (which re-creates with scrollback preserved).
- Remove: `pty_forget` both, destroy browser webview, drop from config. Files on disk
  are never touched.

## 7. Error handling
- Daemon unreachable: UI shows a non-blocking banner "Reconnecting to session
  daemon…" and terminals are read-only until reconnected.
- Session exit: `pty:exit` sets the session state to `exited`; the terminal keeps its
  scrollback and shows the Restart button.
- `lsof`/`ps` failures: monitor keeps the last good result and surfaces the error text
  in the panel footer.
- Browser page failed to load (server not up yet): the webview shows WebKit's error
  page; the toolbar shows a Reload button. No custom retry loop.
- Config file unreadable: back it up as `config.json.broken-<ts>` and start empty.

## 8. Testing
- **Rust unit**: lsof line parser, ps tree parsing + ancestry attribution, conflict
  detection, ring buffer semantics, protocol serde round-trips, config atomic write.
- **Daemon integration** (cargo test): start daemon on a temp socket, `create` a session
  with `initial_command="echo hangar-ok"`, assert `output` contains `hangar-ok`, `kill`,
  restart the daemon, `create` the same id, assert `scrollback` includes the earlier text
  and the marker line.
- **Frontend unit** (vitest): store reducers (add/remove/reorder/layout), status-dot
  derivation, default browser URL selection, saved-command editing.
- **Manual E2E** via `npm run tauri dev`: add two projects, run `npm run dev` in one,
  see its port attributed, preview it, quit and relaunch, confirm reattachment.

## 9. Repository layout
```
hangar/
  package.json  vite.config.ts  index.html  src/            # frontend
  src-tauri/    Cargo.toml (workspace root) src/main.rs      # app + `--daemon` entry
  crates/hangar-protocol/                                    # shared message types
  crates/hangard/                                            # daemon library
  docs/superpowers/specs|plans/
```

## 10. Out of scope (per PRD non-goals)
Code editing, SSH/remote sessions, general browsing (tabs, bookmarks, extensions),
Windows/Linux support, code signing/notarization for distribution.
