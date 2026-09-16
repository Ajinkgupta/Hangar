import { create } from "zustand";
import { config as configIpc, pty, type MonitorSnapshot } from "./lib/ipc";
import type { SessionState } from "./lib/status";
import {
  CHANGES_TAB,
  emptyConfig,
  newProject,
  nextTerminalName,
  normalizeConfig,
  sessionId,
  uid,
  type Config,
  type Project,
  type ProjectLayout,
  type SavedCommand,
} from "./lib/types";
import { terminals } from "./lib/terminals";

const EMPTY_MONITOR: MonitorSnapshot = { ports: [], activity: {}, error: null };
type LiveSessions = Record<string, { pid: number; alive: boolean; exit_code: number | null }>;

export interface HangarState {
  config: Config;
  loaded: boolean;
  daemonConnected: boolean;
  daemonStale: boolean;
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

  addTerminal: (projectId: string, name?: string) => Promise<string>;
  closeTerminal: (projectId: string, terminalId: string) => Promise<void>;
  renameTerminal: (projectId: string, terminalId: string, name: string) => void;

  ensureSessions: (project: Project, live?: LiveSessions) => Promise<void>;
  ensureAllSessions: () => Promise<void>;
  stopSessions: (id: string) => Promise<void>;
  restartSession: (projectId: string, terminalId: string) => Promise<void>;
  setSession: (id: string, patch: Partial<SessionState>) => void;

  setMonitor: (m: MonitorSnapshot) => void;
  toggleShowAllPorts: () => void;
  setDaemonConnected: (v: boolean) => void;
  setDaemonStale: (v: boolean) => void;
  setError: (e: string | null) => void;
}

function patchProject(cfg: Config, id: string, fn: (p: Project) => Project): Config {
  return { ...cfg, projects: cfg.projects.map((p) => (p.id === id ? fn(p) : p)) };
}

export const useStore = create<HangarState>((set, get) => ({
  config: emptyConfig(),
  loaded: false,
  daemonConnected: false,
  daemonStale: false,
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
    const project = get().config.projects.find((p) => p.id === id);
    if (!project) return;
    const wasActive = get().config.activeProjectId === id;
    set((s) => {
      const projects = s.config.projects.filter((p) => p.id !== id);
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([sid]) => !sid.startsWith(id + ":")));
      return {
        config: { ...s.config, projects, activeProjectId: wasActive ? projects[0]?.id ?? null : s.config.activeProjectId },
        sessions,
      };
    });
    for (const t of project.terminals) {
      const sid = sessionId(id, t.id);
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

  addTerminal: async (projectId, name) => {
    const project = get().config.projects.find((p) => p.id === projectId);
    if (!project) return "";
    const tab = { id: uid().slice(0, 8), name: name?.trim() || nextTerminalName(project.terminals) };
    set((s) => ({
      config: patchProject(s.config, projectId, (p) => ({
        ...p,
        terminals: [...p.terminals, tab],
        layout: { ...p.layout, activeTab: tab.id },
      })),
    }));
    const sid = sessionId(projectId, tab.id);
    try {
      const pid = await pty.create(sid, project.path, 120, 30);
      get().setSession(sid, { alive: true, pid, exitCode: null });
    } catch (e) {
      get().setError(String(e));
    }
    return tab.id;
  },

  closeTerminal: async (projectId, terminalId) => {
    const sid = sessionId(projectId, terminalId);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[sid];
      return {
        sessions,
        config: patchProject(s.config, projectId, (p) => {
          const terminals = p.terminals.filter((t) => t.id !== terminalId);
          const idx = p.terminals.findIndex((t) => t.id === terminalId);
          let activeTab = p.layout.activeTab;
          if (activeTab === terminalId) activeTab = terminals[Math.max(0, idx - 1)]?.id ?? CHANGES_TAB;
          return { ...p, terminals, layout: { ...p.layout, activeTab } };
        }),
      };
    });
    terminals.destroy(sid);
    await pty.forget(sid).catch(() => {});
  },

  renameTerminal: (projectId, terminalId, name) =>
    set((s) => ({
      config: patchProject(s.config, projectId, (p) => ({
        ...p,
        terminals: p.terminals.map((t) => (t.id === terminalId ? { ...t, name: name.trim() || t.name } : t)),
      })),
    })),

  ensureSessions: async (project, live) => {
    if (!live) {
      try {
        live = Object.fromEntries((await pty.list()).map((s) => [s.id, s]));
      } catch (e) {
        get().setError(String(e));
        return;
      }
    }
    for (const t of project.terminals) {
      const sid = sessionId(project.id, t.id);
      const existing = live[sid];
      if (existing?.alive) {
        get().setSession(sid, { alive: true, pid: existing.pid, exitCode: null });
        continue;
      }
      try {
        const pid = await pty.create(sid, project.path, 120, 30);
        get().setSession(sid, { alive: true, pid, exitCode: null });
      } catch (e) {
        get().setError(`Could not start terminal "${t.name}" for ${project.name}: ${e}`);
      }
    }
  },

  ensureAllSessions: async () => {
    let live: LiveSessions;
    try {
      live = Object.fromEntries((await pty.list()).map((s) => [s.id, s]));
    } catch (e) {
      get().setError(String(e));
      return;
    }
    await Promise.all(get().config.projects.map((p) => get().ensureSessions(p, live)));
  },

  stopSessions: async (id) => {
    const project = get().config.projects.find((p) => p.id === id);
    if (!project) return;
    for (const t of project.terminals) {
      const sid = sessionId(id, t.id);
      await pty.kill(sid).catch(() => {});
      get().setSession(sid, { alive: false, exitCode: null });
    }
  },

  restartSession: async (projectId, terminalId) => {
    const project = get().config.projects.find((p) => p.id === projectId);
    if (!project) return;
    const sid = sessionId(projectId, terminalId);
    try {
      const pid = await pty.create(sid, project.path, 120, 30);
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
  setDaemonStale: (daemonStale) => set({ daemonStale }),
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
