import { useEffect, useRef, useState } from "react";
import { pollWhileVisible } from "./lib/polling";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { Sidebar } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { EmptyState } from "./components/EmptyState";
import { Overview } from "./components/Overview";
import { CommandPalette } from "./components/CommandPalette";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { automation } from "./lib/automation";
import { applyThemeVars, themeByName } from "./lib/themes";
import { selectActiveProject, useStore } from "./store";
import { daemonRestart, daemonStatus, detectEditors, git, monitorTick, notify, on, traySetStatus } from "./lib/ipc";
import { terminalHooks, terminals } from "./lib/terminals";
import { SPECIAL_TABS, projectOfSession } from "./lib/types";

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const daemonConnected = useStore((s) => s.daemonConnected);
  const daemonStale = useStore((s) => s.daemonStale);
  const lastError = useStore((s) => s.lastError);
  const active = useStore(selectActiveProject);
  const view = useStore((s) => s.view);
  const projectCount = useStore((s) => s.config.projects.filter((p) => p.kind !== "ssh").length);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const worktreeFor = useStore((s) => s.worktreeFor);
  const connectionEditor = useStore((s) => s.connectionEditor);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.config.settings);
  const bootedRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Apply theme + terminal appearance whenever settings change.
  useEffect(() => {
    const t = themeByName(settings.theme);
    applyThemeVars(t);
    terminals.applyAppearance(t.term, settings.fontSize);
  }, [settings.theme, settings.fontSize]);

  // Boot: wire daemon events (idempotent: listeners are re-registered after cleanup),
  // load config and ensure sessions once.
  useEffect(() => {
    const st = useStore.getState();
    const unlisteners: Array<Promise<() => void>> = [];
    unlisteners.push(
      on.ptyOutput((p) => {
        terminals.handleOutput(p.id, p.data);
        useStore.getState().noteOutput(p.id);
        automation.feed(p.id, p.data);
      }),
    );
    unlisteners.push(on.ptyExit((p) => useStore.getState().onSessionExit(p.id, p.code)));
    unlisteners.push(on.ptyBell((p) => onBell(p.id)));
    unlisteners.push(
      on.ptyResync((p) => {
        const ids = p.id === "*" ? terminals.allIds() : [p.id];
        for (const id of ids) terminals.resyncFromDaemon(id);
      }),
    );
    unlisteners.push(
      on.daemonConnected(() => {
        useStore.getState().setDaemonConnected(true);
        void useStore.getState().ensureAllSessions();
      }),
    );
    unlisteners.push(on.daemonDisconnected(() => useStore.getState().setDaemonConnected(false)));
    unlisteners.push(on.daemonBuild((p) => useStore.getState().setDaemonStale(p.stale)));
    terminalHooks.onInput = (id) => useStore.getState().clearAttention(id);
    if (!bootedRef.current) {
      bootedRef.current = true;
      void (async () => {
        await st.init();
        detectEditors().then((e) => useStore.getState().setEditors(e)).catch(() => {});
        // Ask instead of relying on events that may have fired before we listened.
        const status = await daemonStatus().catch(() => ({ connected: false, stale: false, build: null }));
        useStore.getState().setDaemonConnected(status.connected);
        useStore.getState().setDaemonStale(status.stale);
        if (status.connected) await useStore.getState().ensureAllSessions();
      })();
    }
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, []);

  // Port/process monitor. ps+netstat cost a little CPU, so: 2s while the ports panel is
  // on screen, 8s otherwise (status dots / port badges), paused while hidden.
  useEffect(() => {
    let stopped = false;
    let lastGit = 0;
    const cancel = pollWhileVisible(async () => {
      const s = useStore.getState();
      if (!s.loaded) return;
      const pids = Object.fromEntries(Object.entries(s.sessions).filter(([, session]) => session.alive && session.pid).map(([id, session]) => [id, session.pid]));
      try {
        const snapshot = await monitorTick(pids);
        if (stopped) return;
        s.setMonitor(snapshot);
      } catch (e) {
        if (stopped) return;
        s.setMonitor({ ...useStore.getState().monitor, error: String(e) });
      }
      if (document.visibilityState === "visible" && Date.now() - lastGit >= 15_000) {
        lastGit = Date.now();
        const paths = [...new Set(useStore.getState().config.projects.filter((p) => p.kind !== "ssh").map((p) => p.path))];
        if (paths.length) {
          const summaries = await git.summary(paths).catch(() => null);
          if (!stopped && summaries) useStore.getState().setGitSummary(summaries);
        }
      }
    }, () => {
      const s = useStore.getState();
      const active = s.config.projects.find((p) => p.id === s.config.activeProjectId);
      return s.view === "overview" || (s.view === "project" && active?.kind !== "ssh" && active?.layout.portsOpen) ? 2000 : 8000;
    });
    return () => { stopped = true; cancel(); };
  }, []);

  // Menu-bar count: agents waiting / running.
  useEffect(() => {
    let last = "";
    return useStore.subscribe((s) => {
      const waiting = Object.keys(s.attention).length;
      const running = Object.keys(s.monitor.agents).length;
      const key = `${waiting}/${running}`;
      if (key === last) return;
      last = key;
      traySetStatus(waiting, running).catch(() => {});
    });
  }, []);

  // Keyboard shortcuts (capture phase so they win over xterm).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const s = useStore.getState();
      const project = s.config.projects.find((p) => p.id === s.config.activeProjectId);
      const key = e.key.toLowerCase();
      if (key === "," && !e.shiftKey) {
        e.preventDefault();
        s.setSettingsOpen(!s.settingsOpen);
        return;
      }
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
      if (key === "b" && !e.shiftKey && !s.paletteOpen && !s.worktreeFor && !s.connectionEditor && !s.settingsOpen) {
        e.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      // While a dialog is open, or typing in a text field, only the two toggles above apply.
      if (s.paletteOpen || s.worktreeFor || s.connectionEditor || s.settingsOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !target.classList.contains("xterm-helper-textarea")) return;
      if (key === "0" && !e.shiftKey) {
        e.preventDefault();
        s.setView(s.view === "overview" ? "project" : "overview");
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const target = s.config.projects.filter((p) => p.kind !== "ssh")[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          s.setActive(target.id);
        }
        return;
      }
      if (!project || s.view !== "project") return;
      const tabs = [...project.terminals.map((t) => t.id), ...(project.kind === "ssh" ? [] : SPECIAL_TABS)];
      const idx = tabs.indexOf(project.layout.activeTab);
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        void s.addTerminal(project.id);
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (project.terminals.some((t) => t.id === project.layout.activeTab) && project.terminals.length > 1) {
          void s.closeTerminal(project.id, project.layout.activeTab);
        }
      } else if (tabs.length && e.shiftKey && (key === "]" || key === "}")) {
        e.preventDefault();
        s.updateLayout(project.id, { activeTab: tabs[(idx + 1) % tabs.length] });
      } else if (tabs.length && e.shiftKey && (key === "[" || key === "{")) {
        e.preventDefault();
        s.updateLayout(project.id, { activeTab: tabs[(idx - 1 + tabs.length) % tabs.length] });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // No native right-click menu outside text inputs (the terminal handles its own).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.classList.contains("xterm-helper-textarea")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  if (!loaded) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      {sidebarOpen && <Sidebar />}
      <main className="main">
        <WorkspaceBar sidebarOpen={sidebarOpen} toggleSidebar={() => setSidebarOpen((open) => !open)} />
        {!daemonConnected && <div className="banner warn">Reconnecting to session daemon…</div>}
        {daemonConnected && daemonStale && (
          <div className="banner warn">
            The background session daemon is from an older Hangar build.{" "}
            <button className="small" onClick={() => void daemonRestart().catch((e) => useStore.getState().setError(String(e)))}>
              Restart daemon
            </button>{" "}
            <span className="hint">(ends current terminals; scrollback is kept)</span>
          </div>
        )}
        {lastError && (
          <div className="banner error" onClick={() => useStore.getState().setError(null)}>
            {lastError} <span className="dismiss">×</span>
          </div>
        )}
        {view === "overview" ? (
          <Overview />
        ) : active ? (
          <ProjectView key={active.id} project={active} />
        ) : (
          <EmptyState hasProjects={projectCount > 0} />
        )}
      </main>
      {paletteOpen && <CommandPalette />}
      {worktreeFor && <WorktreeDialog projectId={worktreeFor} />}
      {connectionEditor && <ConnectionDialog editing={connectionEditor} />}
      {settingsOpen && <SettingsDialog />}
    </div>
  );
}

const lastNotified: Record<string, number> = {};

/** A terminal rang its bell (coding agents do this when they finish or need
 *  permission). If the user isn't looking at that terminal, flag it and notify. */
function onBell(sid: string) {
  const s = useStore.getState();
  const projectId = projectOfSession(sid);
  const project = s.config.projects.find((p) => p.id === projectId);
  if (!project) return;
  const terminalId = sid.split(":")[1];
  const looking =
    document.hasFocus() && s.view === "project" && s.config.activeProjectId === projectId && project.layout.activeTab === terminalId;
  if (looking) return;
  s.markAttention(sid);
  const now = Date.now();
  if (now - (lastNotified[sid] ?? 0) < 5000) return;
  lastNotified[sid] = now;
  if (!document.hasFocus() && s.config.settings.notifications) {
    const tab = project.terminals.find((t) => t.id === terminalId);
    const agent = s.monitor.agents[sid];
    notify(project.name, `${agent ? agent + " in " : ""}${tab?.name ?? "terminal"} needs you`, s.config.settings.sound).catch(() => {});
  }
}
