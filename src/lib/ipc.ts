import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SessionInfo = { id: string; cwd: string; pid: number; alive: boolean; exit_code: number | null };
export type PortRow = {
  port: number;
  addr: string;
  pid: number;
  process: string;
  session_id: string | null;
  conflict: boolean;
};
export type MonitorSnapshot = {
  ports: PortRow[];
  activity: Record<string, number>;
  agents: Record<string, string>;
  error: string | null;
};
export type GitSummary = { path: string; is_repo: boolean; files: number; additions: number; deletions: number; branch: string };
export type FileStatus = { path: string; status: string; staged: boolean; old_path: string | null };
export type GitStatus = { is_repo: boolean; files: FileStatus[]; error: string | null };

export const pty = {
  list: () => invoke<SessionInfo[]>("pty_list"),
  create: (id: string, cwd: string, cols: number, rows: number, initialCommand?: string) =>
    invoke<number>("pty_create", { id, cwd, cols, rows, initialCommand: initialCommand ?? null }),
  scrollback: (id: string) => invoke<string>("pty_scrollback", { id }),
  tail: (id: string, lines: number) => invoke<string[]>("pty_tail", { id, lines }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
  forget: (id: string) => invoke<void>("pty_forget", { id }),
};

export const daemonStatus = () => invoke<boolean>("daemon_status");
export const daemonRestart = () => invoke<void>("daemon_restart");
export const openUrl = (url: string) => invoke<void>("open_url", { url });
export const openInEditor = (appName: string, path: string) => invoke<void>("open_in_editor", { appName, path });
export const detectEditors = () => invoke<string[]>("detect_editors");
export const notify = (title: string, body: string, sound: boolean) => invoke<void>("notify", { title, body, sound });
export const secrets = {
  set: (key: string, value: string) => invoke<void>("secret_set", { key, value }),
  get: (key: string) => invoke<string>("secret_get", { key }),
  delete: (key: string) => invoke<void>("secret_delete", { key }),
};
export const traySetStatus = (waiting: number, running: number) => invoke<void>("tray_set_status", { waiting, running });

export const monitorTick = (sessionPids: Record<string, number>) =>
  invoke<MonitorSnapshot>("monitor_tick", { sessionPids });
export const killProcess = (pid: number, force: boolean) => invoke<void>("kill_process", { pid, force });

export const git = {
  status: (path: string) => invoke<GitStatus>("git_status", { path }),
  diff: (path: string, file: string, untracked: boolean, oldPath: string | null) =>
    invoke<string>("git_diff", { path, file, untracked, oldPath }),
  summary: (paths: string[]) => invoke<GitSummary[]>("git_summary", { paths }),
  worktreeAdd: (path: string, branch: string) => invoke<string>("git_worktree_add", { path, branch }),
};

export const config = {
  load: () => invoke<unknown>("config_load"),
  save: (value: unknown) => invoke<void>("config_save", { value }),
};

export const on = {
  ptyOutput: (cb: (p: { id: string; data: string }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>("pty:output", (e) => cb(e.payload)),
  ptyExit: (cb: (p: { id: string; code: number | null }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; code: number | null }>("pty:exit", (e) => cb(e.payload)),
  ptyBell: (cb: (p: { id: string }) => void): Promise<UnlistenFn> => listen<{ id: string }>("pty:bell", (e) => cb(e.payload)),
  daemonConnected: (cb: () => void) => listen("daemon:connected", () => cb()),
  daemonDisconnected: (cb: () => void) => listen("daemon:disconnected", () => cb()),
  daemonBuild: (cb: (p: { stale: boolean; build: string }) => void) =>
    listen<{ stale: boolean; build: string }>("daemon:build", (e) => cb(e.payload)),
};

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64decode(b: string): Uint8Array {
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
