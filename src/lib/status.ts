import type { MonitorSnapshot } from "./ipc";
import { sessionId } from "./types";

export type ProjectStatus = "running" | "idle" | "error";
export type SessionState = { alive: boolean; pid: number; exitCode: number | null };

export function deriveStatus(
  projectId: string,
  sessions: Record<string, SessionState>,
  monitor: MonitorSnapshot,
): ProjectStatus {
  const ids = [sessionId(projectId, "claude"), sessionId(projectId, "shell")];
  if (ids.some((id) => sessions[id] && !sessions[id].alive)) return "error";
  if (ids.some((id) => (monitor.activity[id] ?? 0) > 0)) return "running";
  if (monitor.ports.some((p) => p.session_id !== null && ids.includes(p.session_id))) return "running";
  return "idle";
}

/** Lowest listening port owned by any of the project's sessions, if any. */
export function projectPort(projectId: string, monitor: MonitorSnapshot): number | null {
  const ports = monitor.ports
    .filter((p) => p.session_id !== null && p.session_id.startsWith(projectId + ":"))
    .map((p) => p.port);
  return ports.length ? Math.min(...ports) : null;
}
