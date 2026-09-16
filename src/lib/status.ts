import type { MonitorSnapshot } from "./ipc";

export type ProjectStatus = "running" | "idle" | "error";
export type SessionState = { alive: boolean; pid: number; exitCode: number | null };

export function deriveStatus(
  projectId: string,
  sessions: Record<string, SessionState>,
  monitor: MonitorSnapshot,
): ProjectStatus {
  const mine = (id: string) => id.startsWith(projectId + ":");
  if (Object.entries(sessions).some(([id, s]) => mine(id) && !s.alive)) return "error";
  if (Object.entries(monitor.activity).some(([id, n]) => mine(id) && n > 0)) return "running";
  if (monitor.ports.some((p) => p.session_id !== null && mine(p.session_id))) return "running";
  return "idle";
}

/** Lowest listening port owned by any of the project's sessions, if any. */
export function projectPort(projectId: string, monitor: MonitorSnapshot): number | null {
  const ports = monitor.ports
    .filter((p) => p.session_id !== null && p.session_id.startsWith(projectId + ":"))
    .map((p) => p.port);
  return ports.length ? Math.min(...ports) : null;
}
