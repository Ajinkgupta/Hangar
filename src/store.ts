import { create } from "zustand";
import { config as configIpc, pty, type MonitorSnapshot } from "./lib/ipc";
import type { SessionState } from "./lib/status";
import {
  emptyConfig,
  newProject,
  normalizeConfig,
  sessionId,
  type Config,
  type Project,
  type ProjectLayout,
  type SavedCommand,
  type SessionKind,
} from "./lib/types";
import { terminals } from "./lib/terminals";

const EMPTY_MONITOR: MonitorSnapshot = { ports: [], activity: {}, error: null };

export interface HangarState {
  config: Config;
  loaded: boolean;
  daemonConnected: boolean;
  sessions: Record<string, SessionState>;
  monitor: MonitorSnapshot;
  showAllPorts: boolean;
  lastError: string | null;

  init: () => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => void;
  reorderProjects: (ids: string[]) => void;
  setActive: (id: string | null) => void;
  updateLayout: (id: string, patch: Partial<ProjectLayout>) => void;
  setCommands: (id: string, commands: SavedCommand[]) => void;
  setClaudeCommand: (id: string, cmd: string) => void;

  ensureSessions: (project: Project) => Promise<void>;
  ensureAllSessions: () => Promise<void>;
  stopSessions: (id: string) => Promise<void>;
  restartSession: (projectId: string, kind: SessionKind) => Promise<void>;
  setSession: (id: string, patch: Partial<SessionState>) => void;

  setMonitor: (m: MonitorSnapshot) => void;
  toggleShowAllPorts: () => void;
  setDaemonConnected: (v: boolean) => void;
  setError: (e: string | null) => void;
}

function patchProject(cfg: Config, id: string, fn: (p: Project) => Project): Config {
  return { ...cfg, projects: cfg.projects.map((p) => (p.id === id ? fn(p) : p)) };
}

export const useStore = create<HangarState>((set, get) => ({
  config: emptyConfig(),
  loaded: false,
  daemonConnected: false,
  sessions: {},
  monitor: EMPTY_MONITOR,
  showAllPorts: false,
  lastError: null,

  init: async () => {
    const raw = await configIpc.load();
    const cfg = normalizeConfig(raw);
    if (cfg.activeProjectId && !cfg.projects.some((p) => p.id === cfg.activeProjectId)) {
      cfg.activeProjectId = cfg.projects[0]?.id ?? null;
    }
    set({ config: cfg, loaded: true });
  },

  addProject: async (path) => {
    const p = newProject(path.trim());
    set((s) => ({ config: { ...s.config, projects: [...s.config.projects, p], activeProjectId: p.id } }));
    await get().ensureSessions(p);
  },

  removeProject: async (id) => {
    const wasActive = get().config.activeProjectId === id;
    set((s) => {
      const projects = s.config.projects.filter((p) => p.id !== id);
      const sessions = { ...s.sessions };
      delete sessions[sessionId(id, "claude")];
      delete sessions[sessionId(id, "shell")];
      return {
        config: { ...s.config, projects, activeProjectId: wasActive ? projects[0]?.id ?? null : s.config.activeProjectId },
        sessions,
      };
    });
    for (const kind of ["claude", "shell"] as const) {
      const sid = sessionId(id, kind);
      terminals.destroy(sid);
      await pty.forget(sid).catch(() => {});
    }
  },

  renameProject: (id, name) => set((s) => ({ config: patchProject(s.config, id, (p) => ({ ...p, name })) })),

  reorderProjects: (ids) =>
    set((s) => {
      const byId = new Map(s.config.projects.map((p) => [p.id, p]));
      const projects = ids.map((i) => byId.get(i)!).filter(Boolean);
      return { config: { ...s.config, projects } };
    }),

  setActive: (id) => set((s) => ({ config: { ...s.config, activeProjectId: id } })),

  updateLayout: (id, patch) =>
    set((s) => ({ config: patchProject(s.config, id, (p) => ({ ...p, layout: { ...p.layout, ...patch } })) })),

  setCommands: (id, commands) => set((s) => ({ config: patchProject(s.config, id, (p) => ({ ...p, commands })) })),

  setClaudeCommand: (id, claudeCommand) =>
    set((s) => ({ config: patchProject(s.config, id, (p) => ({ ...p, claudeCommand })) })),

  ensureSessions: async (project) => {
    if (!get().daemonConnected) return;
    let live: Record<string, { pid: number; alive: boolean; exit_code: number | null }> = {};
    try {
      live = Object.fromEntries((await pty.list()).map((s) => [s.id, s]));
    } catch (e) {
      get().setError(String(e));
      return;
    }
    for (const kind of ["claude", "shell"] as const) {
      const sid = sessionId(project.id, kind);
      const existing = live[sid];
      if (existing?.alive) {
        get().setSession(sid, { alive: true, pid: existing.pid, exitCode: null });
        continue;
      }
      try {
        const pid = await pty.create(sid, project.path, 120, 30, kind === "claude" ? project.claudeCommand : undefined);
        get().setSession(sid, { alive: true, pid, exitCode: null });
      } catch (e) {
        get().setError(`Could not start ${kind} session for ${project.name}: ${e}`);
      }
    }
  },

  ensureAllSessions: async () => {
    for (const p of get().config.projects) await get().ensureSessions(p);
  },

  stopSessions: async (id) => {
    for (const kind of ["claude", "shell"] as const) {
      const sid = sessionId(id, kind);
      await pty.kill(sid).catch(() => {});
      get().setSession(sid, { alive: false, exitCode: null });
    }
  },

  restartSession: async (projectId, kind) => {
    const project = get().config.projects.find((p) => p.id === projectId);
    if (!project) return;
    const sid = sessionId(projectId, kind);
    try {
      const pid = await pty.create(sid, project.path, 120, 30, kind === "claude" ? project.claudeCommand : undefined);
      terminals.markRestarted(sid);
      get().setSession(sid, { alive: true, pid, exitCode: null });
    } catch (e) {
      get().setError(String(e));
    }
  },

  setSession: (id, patch) =>
    set((s) => {
      const prev: SessionState = s.sessions[id] ?? { alive: true, pid: 0, exitCode: null };
      return { sessions: { ...s.sessions, [id]: { ...prev, ...patch } } };
    }),

  setMonitor: (monitor) => set({ monitor }),
  toggleShowAllPorts: () => set((s) => ({ showAllPorts: !s.showAllPorts })),
  setDaemonConnected: (daemonConnected) => set({ daemonConnected }),
  setError: (lastError) => set({ lastError }),
}));

// Persist config (debounced) whenever it changes after load.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (!s.loaded || s.config === prev.config) return;
  if (saveTimer) clearTimeout(saveTimer);
  const snapshot = s.config;
  saveTimer = setTimeout(() => {
    configIpc.save(snapshot).catch((e) => useStore.getState().setError(`Could not save config: ${e}`));
  }, 300);
});

export const selectActiveProject = (s: HangarState): Project | null =>
  s.config.projects.find((p) => p.id === s.config.activeProjectId) ?? null;
