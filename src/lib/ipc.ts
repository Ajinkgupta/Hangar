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
export type MonitorSnapshot = { ports: PortRow[]; activity: Record<string, number>; error: string | null };
export type FileStatus = { path: string; status: string; staged: boolean; old_path: string | null };
export type GitStatus = { is_repo: boolean; files: FileStatus[]; error: string | null };
export type Bounds = { x: number; y: number; width: number; height: number };

export const pty = {
  list: () => invoke<SessionInfo[]>("pty_list"),
  create: (id: string, cwd: string, cols: number, rows: number, initialCommand?: string) =>
    invoke<number>("pty_create", { id, cwd, cols, rows, initialCommand: initialCommand ?? null }),
  scrollback: (id: string) => invoke<string>("pty_scrollback", { id }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
  forget: (id: string) => invoke<void>("pty_forget", { id }),
};

export const daemonStatus = () => invoke<boolean>("daemon_status");

export const monitorTick = (sessionPids: Record<string, number>) =>
  invoke<MonitorSnapshot>("monitor_tick", { sessionPids });
export const killProcess = (pid: number, force: boolean) => invoke<void>("kill_process", { pid, force });

export const git = {
  status: (path: string) => invoke<GitStatus>("git_status", { path }),
  diff: (path: string, file: string, untracked: boolean, oldPath: string | null) =>
    invoke<string>("git_diff", { path, file, untracked, oldPath }),
};

export const config = {
  load: () => invoke<unknown>("config_load"),
  save: (value: unknown) => invoke<void>("config_save", { value }),
};

export const browser = {
  show: (projectId: string, url: string, bounds: Bounds) => invoke<void>("browser_show", { projectId, url, bounds }),
  hide: (projectId: string) => invoke<void>("browser_hide", { projectId }),
  navigate: (projectId: string, url: string) => invoke<void>("browser_navigate", { projectId, url }),
  back: (projectId: string) => invoke<void>("browser_back", { projectId }),
  forward: (projectId: string) => invoke<void>("browser_forward", { projectId }),
  reload: (projectId: string) => invoke<void>("browser_reload", { projectId }),
  setBounds: (projectId: string, bounds: Bounds) => invoke<void>("browser_set_bounds", { projectId, bounds }),
  destroy: (projectId: string) => invoke<void>("browser_destroy", { projectId }),
};

export const on = {
  ptyOutput: (cb: (p: { id: string; data: string }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>("pty:output", (e) => cb(e.payload)),
  ptyExit: (cb: (p: { id: string; code: number | null }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; code: number | null }>("pty:exit", (e) => cb(e.payload)),
  daemonConnected: (cb: () => void) => listen("daemon:connected", () => cb()),
  daemonDisconnected: (cb: () => void) => listen("daemon:disconnected", () => cb()),
  browserNavigated: (cb: (p: { project_id: string; url: string; finished: boolean }) => void) =>
    listen<{ project_id: string; url: string; finished: boolean }>("browser:navigated", (e) => cb(e.payload)),
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
