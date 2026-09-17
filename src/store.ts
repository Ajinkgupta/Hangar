import { create } from "zustand";
import { b64encode, config as configIpc, git, pty, secrets, type GitSummary, type MonitorSnapshot } from "./lib/ipc";
import { automation } from "./lib/automation";
import type { SessionState } from "./lib/status";
import {
  FILES_TAB,
  SSH_PROJECT_ID,
  projectOfSession,
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
  type Connection,
  type ConnectionStep,
  type Settings,
  type Task,
} from "./lib/types";
import { terminals } from "./lib/terminals";

const EMPTY_MONITOR: MonitorSnapshot = { ports: [], activity: {}, agents: {}, error: null };
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
  /** session id -> when its bell last rang and nobody was looking */
  attention: Record<string, number>;
  /** session id -> last time output arrived (throttled to ~1/s) */
  lastOutput: Record<string, number>;
  gitSummary: Record<string, GitSummary>;
  editors: string[];
  view: "project" | "overview";
  paletteOpen: boolean;
  worktreeFor: string | null;
  connectionEditor: Connection | "new" | null;
  /** session id -> connection automation state for the UI */
  connecting: Record<string, "running" | "done">;
  /** session id -> when a saved command/connection was last typed into it */
  launchedAt: Record<string, number>;
  settingsOpen: boolean;

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
  /** Run a saved command in its own tab; if it is still running there, just switch to it. */
  runSavedCommand: (projectId: string, commandId: string, forceNewTab?: boolean) => Promise<void>;

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

  markAttention: (sessionId: string) => void;
  clearAttention: (sessionId: string) => void;
  noteOutput: (sessionId: string) => void;
  setGitSummary: (list: GitSummary[]) => void;
  setEditors: (e: string[]) => void;
  setView: (v: "project" | "overview") => void;
  setPaletteOpen: (v: boolean) => void;
  setWorktreeFor: (projectId: string | null) => void;
  addWorktree: (projectId: string, branch: string) => Promise<void>;

  setConnectionEditor: (c: Connection | "new" | null) => void;
  saveConnection: (c: Connection, plainSecrets: Record<number, string>) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  runConnection: (id: string) => Promise<void>;

  /** A session ended (from the daemon). Ignored for tabs that no longer exist. */
  onSessionExit: (sessionId: string, code: number | null) => void;
  setTasks: (projectId: string, tasks: Task[]) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setSettingsOpen: (v: boolean) => void;
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
  attention: {},
  lastOutput: {},
  gitSummary: {},
  editors: [],
  view: "project",
  paletteOpen: false,
  worktreeFor: null,
  connectionEditor: null,
  connecting: {},
  launchedAt: {},
  settingsOpen: false,

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
      automation.stop(sid);
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

  setActive: (id) => set((s) => ({ config: { ...s.config, activeProjectId: id }, view: "project" })),

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
      terminals.resync(sid);
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
          if (activeTab === terminalId) activeTab = terminals[Math.max(0, idx - 1)]?.id ?? FILES_TAB;
          const commandRuns = Object.fromEntries(Object.entries(p.commandRuns).filter(([, tid]) => tid !== terminalId));
          return { ...p, terminals, commandRuns, layout: { ...p.layout, activeTab } };
        }),
      };
    });
    if (projectId === SSH_PROJECT_ID) {
      set((s) => ({
        config: { ...s.config, connectionRuns: Object.fromEntries(Object.entries(s.config.connectionRuns).filter(([, tid]) => tid !== terminalId)) },
      }));
    }
    automation.stop(sid);
    set((s) => {
      const connecting = { ...s.connecting };
      delete connecting[sid];
      const launchedAt = { ...s.launchedAt };
      delete launchedAt[sid];
      return { connecting, launchedAt };
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

  runSavedCommand: async (projectId, commandId, forceNewTab = false) => {
    const s = get();
    const project = s.config.projects.find((p) => p.id === projectId);
    const cmd = project?.commands.find((c) => c.id === commandId);
    if (!project || !cmd) return;
    const ownedId = project.commandRuns[commandId];
    const owned = !forceNewTab ? project.terminals.find((t) => t.id === ownedId) : undefined;
    if (owned) {
      const sid = sessionId(projectId, owned.id);
      s.updateLayout(projectId, { activeTab: owned.id });
      const alive = s.sessions[sid]?.alive !== false;
      // Activity is polled every few seconds; a command typed moments ago counts as running.
      const justLaunched = Date.now() - (s.launchedAt[sid] ?? 0) < 10_000;
      const running = (s.monitor.activity[sid] ?? 0) > 0 || justLaunched;
      if (alive && running) {
        requestAnimationFrame(() => terminals.focus(sid));
        return; // still running: just show it
      }
      if (!alive) await s.restartSession(projectId, owned.id);
      set((st) => ({ launchedAt: { ...st.launchedAt, [sid]: Date.now() } }));
      pty.write(sid, b64encode(cmd.command + "\r")).catch((e) => get().setError(String(e)));
      requestAnimationFrame(() => terminals.focus(sid));
      return;
    }
    const terminalId = await s.addTerminal(projectId, cmd.label);
    if (!terminalId) return;
    set((st) => ({
      config: patchProject(st.config, projectId, (p) => ({ ...p, commandRuns: { ...p.commandRuns, [commandId]: terminalId } })),
    }));
    const sid = sessionId(projectId, terminalId);
    set((st) => ({ launchedAt: { ...st.launchedAt, [sid]: Date.now() } }));
    await new Promise((r) => setTimeout(r, 300)); // let the shell print its prompt
    pty.write(sid, b64encode(cmd.command + "\r")).catch((e) => get().setError(String(e)));
    requestAnimationFrame(() => terminals.focus(sid));
  },

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
      // The user may have closed this tab while we were awaiting: never recreate it.
      const stillThere = get().config.projects.find((p) => p.id === project.id)?.terminals.some((x) => x.id === t.id);
      if (!stillThere) continue;
      const sid = sessionId(project.id, t.id);
      const existing = live[sid];
      if (existing?.alive) {
        get().setSession(sid, { alive: true, pid: existing.pid, exitCode: null });
        continue;
      }
      try {
        const pid = await pty.create(sid, project.path, 120, 30);
        get().setSession(sid, { alive: true, pid, exitCode: null });
        if (existing) terminals.markRestarted(sid); // it died while we were away: say so
        else terminals.resync(sid);
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

  markAttention: (sid) => set((s) => ({ attention: { ...s.attention, [sid]: Date.now() } })),
  clearAttention: (sid) =>
    set((s) => {
      if (!(sid in s.attention)) return s;
      const attention = { ...s.attention };
      delete attention[sid];
      return { attention };
    }),
  noteOutput: (sid) =>
    set((s) => {
      const now = Date.now();
      if (now - (s.lastOutput[sid] ?? 0) < 1000) return s;
      return { lastOutput: { ...s.lastOutput, [sid]: now } };
    }),
  setGitSummary: (list) => set({ gitSummary: Object.fromEntries(list.map((g) => [g.path, g])) }),
  setEditors: (editors) => set({ editors }),
  setView: (view) => set({ view }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setWorktreeFor: (worktreeFor) => set({ worktreeFor }),
  setConnectionEditor: (connectionEditor) => set({ connectionEditor }),

  saveConnection: async (c, plainSecrets) => {
    // Secrets never touch config.json: they go to the Keychain under a per-step key.
    const steps: ConnectionStep[] = [];
    for (let i = 0; i < c.steps.length; i++) {
      const st = { ...c.steps[i] };
      if (plainSecrets[i] !== undefined) {
        const key = `hangar-conn-${c.id}-${i}`;
        try {
          await secrets.set(key, plainSecrets[i]);
          st.secretRef = key;
          st.send = "";
        } catch (e) {
          get().setError(`Keychain: ${e}`);
          return;
        }
      }
      steps.push(st);
    }
    const conn = { ...c, steps };
    set((s) => {
      const exists = s.config.connections.some((x) => x.id === conn.id);
      const connections = exists ? s.config.connections.map((x) => (x.id === conn.id ? conn : x)) : [...s.config.connections, conn];
      return { config: { ...s.config, connections }, connectionEditor: null };
    });
  },

  removeConnection: async (id) => {
    const c = get().config.connections.find((x) => x.id === id);
    for (const st of c?.steps ?? []) if (st.secretRef) await secrets.delete(st.secretRef).catch(() => {});
    set((s) => {
      const connectionRuns = { ...s.config.connectionRuns };
      delete connectionRuns[id];
      return { config: { ...s.config, connections: s.config.connections.filter((x) => x.id !== id), connectionRuns }, connectionEditor: null };
    });
  },

  runConnection: async (id) => {
    const c = get().config.connections.find((x) => x.id === id);
    if (!c) return;
    // Resolve secrets first so a Keychain failure stops before a terminal is opened.
    const resolved: Array<ConnectionStep & { resolved: string }> = [];
    for (const st of c.steps) {
      let value = st.send;
      if (st.secretRef) {
        try {
          value = await secrets.get(st.secretRef);
        } catch (e) {
          get().setError(`Could not read the saved password for "${c.name}": ${e}`);
          return;
        }
      }
      resolved.push({ ...st, resolved: value });
    }
    get().setActive(SSH_PROJECT_ID);
    const ssh = get().config.projects.find((p) => p.id === SSH_PROJECT_ID);
    const ownedId = get().config.connectionRuns[id];
    const owned = ssh?.terminals.find((t) => t.id === ownedId);
    let terminalId: string;
    let freshShell = false;
    if (owned) {
      terminalId = owned.id;
      const sid = sessionId(SSH_PROJECT_ID, terminalId);
      get().updateLayout(SSH_PROJECT_ID, { activeTab: terminalId });
      const alive = get().sessions[sid]?.alive !== false;
      const justLaunched = Date.now() - (get().launchedAt[sid] ?? 0) < 10_000;
      const connected = (get().monitor.activity[sid] ?? 0) > 0 || automation.isRunning(sid) || justLaunched;
      if (alive && connected) {
        requestAnimationFrame(() => terminals.focus(sid));
        return; // already connected: just show it
      }
      if (!alive) {
        await get().restartSession(SSH_PROJECT_ID, terminalId);
        freshShell = true;
      }
    } else {
      terminalId = await get().addTerminal(SSH_PROJECT_ID, c.name);
      if (!terminalId) return;
      set((s) => ({ config: { ...s.config, connectionRuns: { ...s.config.connectionRuns, [id]: terminalId } } }));
      freshShell = true;
    }
    const sid = sessionId(SSH_PROJECT_ID, terminalId);
    // A fresh shell needs a moment to print its prompt before we type.
    if (freshShell) await new Promise((r) => setTimeout(r, 350));
    set((s) => ({ connecting: { ...s.connecting, [sid]: "running" }, launchedAt: { ...s.launchedAt, [sid]: Date.now() } }));
    // Arm the expect/send script only now, so the local prompt can't trigger a step.
    automation.start(sid, resolved, {
      onDone: () => set((s) => ({ connecting: { ...s.connecting, [sid]: "done" } })),
    });
    pty.write(sid, b64encode(c.command + "\r")).catch((e) => get().setError(String(e)));
    requestAnimationFrame(() => terminals.focus(sid));
  },

  onSessionExit: (sid, code) => {
    const s = get();
    const pid = projectOfSession(sid);
    const tid = sid.slice(pid.length + 1);
    const project = s.config.projects.find((p) => p.id === pid);
    if (!project || !project.terminals.some((t) => t.id === tid)) return; // tab already closed
    automation.stop(sid);
    set((st) => {
      const connecting = { ...st.connecting };
      delete connecting[sid];
      return { connecting };
    });
    s.setSession(sid, { alive: false, exitCode: code });
  },

  setTasks: (projectId, tasks) => set((s) => ({ config: patchProject(s.config, projectId, (p) => ({ ...p, tasks })) })),

  setSettings: (patch) => set((s) => ({ config: { ...s.config, settings: { ...s.config.settings, ...patch } } })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  addWorktree: async (projectId, branch) => {
    const project = get().config.projects.find((p) => p.id === projectId);
    if (!project) return;
    try {
      const path = await git.worktreeAdd(project.path, branch);
      const p = { ...newProject(path), name: `${project.name} · ${branch}` };
      set((s) => ({ config: { ...s.config, projects: [...s.config.projects, p], activeProjectId: p.id }, view: "project", worktreeFor: null }));
      await get().ensureSessions(p);
    } catch (e) {
      get().setError(`Worktree failed: ${e}`);
    }
  },
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
