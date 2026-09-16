import { useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { EmptyState } from "./components/EmptyState";
import { Overview } from "./components/Overview";
import { CommandPalette } from "./components/CommandPalette";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { automation } from "./lib/automation";
import { selectActiveProject, useStore } from "./store";
import { daemonRestart, daemonStatus, detectEditors, git, monitorTick, notify, on, traySetStatus } from "./lib/ipc";
import { terminalHooks, terminals } from "./lib/terminals";
import { CHANGES_TAB, projectOfSession } from "./lib/types";

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const daemonConnected = useStore((s) => s.daemonConnected);
  const daemonStale = useStore((s) => s.daemonStale);
  const lastError = useStore((s) => s.lastError);
  const active = useStore(selectActiveProject);
  const view = useStore((s) => s.view);
  const projectCount = useStore((s) => s.config.projects.length);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const worktreeFor = useStore((s) => s.worktreeFor);
  const connectionEditor = useStore((s) => s.connectionEditor);
  const startedRef = useRef(false);

  // Boot: load config, wire daemon events, ensure sessions.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const st = useStore.getState();
    const unlisteners: Array<Promise<() => void>> = [];
    unlisteners.push(
      on.ptyOutput((p) => {
        terminals.handleOutput(p.id, p.data);
        useStore.getState().noteOutput(p.id);
        automation.feed(p.id, p.data);
      }),
    );
    unlisteners.push(on.ptyExit((p) => useStore.getState().setSession(p.id, { alive: false, exitCode: p.code })));
    unlisteners.push(on.ptyBell((p) => onBell(p.id)));
    unlisteners.push(
      on.daemonConnected(() => {
        useStore.getState().setDaemonConnected(true);
        void useStore.getState().ensureAllSessions();
      }),
    );
    unlisteners.push(on.daemonDisconnected(() => useStore.getState().setDaemonConnected(false)));
    unlisteners.push(on.daemonBuild((p) => useStore.getState().setDaemonStale(p.stale)));
    terminalHooks.onInput = (id) => useStore.getState().clearAttention(id);
    void (async () => {
      await st.init();
      detectEditors().then((e) => useStore.getState().setEditors(e)).catch(() => {});
      const connected = await daemonStatus().catch(() => false);
      useStore.getState().setDaemonConnected(connected);
      if (connected) await useStore.getState().ensureAllSessions();
    })();
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, []);

  // Port/process monitor. ps+netstat cost a little CPU, so: 2s while the ports panel is
  // on screen, 8s otherwise (status dots / port badges), paused while hidden.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let n = 0;
    const interval = () => {
      const s = useStore.getState();
      const a = s.config.projects.find((p) => p.id === s.config.activeProjectId);
      return a?.layout.portsOpen || s.view === "overview" ? 2000 : 8000;
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        const s = useStore.getState();
        const pids: Record<string, number> = {};
        for (const [sid, sess] of Object.entries(s.sessions)) {
          if (sess.alive && sess.pid) pids[sid] = sess.pid;
        }
        try {
          s.setMonitor(await monitorTick(pids));
        } catch (e) {
          s.setMonitor({ ...s.monitor, error: String(e) });
        }
        // Git badges: every ~15s.
        if (n++ % 4 === 0 && s.config.projects.length) {
          git.summary(s.config.projects.map((p) => p.path)).then((r) => useStore.getState().setGitSummary(r)).catch(() => {});
        }
      }
      timer = setTimeout(tick, interval());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
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
      const tabs = [...project.terminals.map((t) => t.id), CHANGES_TAB];
      const idx = tabs.indexOf(project.layout.activeTab);
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        void s.addTerminal(project.id);
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (project.layout.activeTab !== CHANGES_TAB && project.terminals.length > 1) {
          void s.closeTerminal(project.id, project.layout.activeTab);
        }
      } else if (e.shiftKey && (key === "]" || key === "}")) {
        e.preventDefault();
        s.updateLayout(project.id, { activeTab: tabs[(idx + 1) % tabs.length] });
      } else if (e.shiftKey && (key === "[" || key === "{")) {
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
      <Sidebar />
      <main className="main">
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
    </div>
  );
}

const lastNotified: Record<string, number> = {};

/** A terminal rang its bell (Claude Code / cursor-agent do this when they finish or need
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
  if (!document.hasFocus()) {
    const tab = project.terminals.find((t) => t.id === terminalId);
    const agent = s.monitor.agents[sid];
    notify(project.name, `${agent ? agent + " in " : ""}${tab?.name ?? "terminal"} needs you`, true).catch(() => {});
  }
}
