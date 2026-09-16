import { useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { EmptyState } from "./components/EmptyState";
import { selectActiveProject, useStore } from "./store";
import { daemonRestart, daemonStatus, monitorTick, on } from "./lib/ipc";
import { terminals } from "./lib/terminals";
import { CHANGES_TAB } from "./lib/types";

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const daemonConnected = useStore((s) => s.daemonConnected);
  const daemonStale = useStore((s) => s.daemonStale);
  const lastError = useStore((s) => s.lastError);
  const active = useStore(selectActiveProject);
  const projectCount = useStore((s) => s.config.projects.length);
  const startedRef = useRef(false);

  // Boot: load config, wire daemon events, ensure sessions.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const st = useStore.getState();
    const unlisteners: Array<Promise<() => void>> = [];
    unlisteners.push(on.ptyOutput((p) => terminals.handleOutput(p.id, p.data)));
    unlisteners.push(on.ptyExit((p) => useStore.getState().setSession(p.id, { alive: false, exitCode: p.code })));
    unlisteners.push(
      on.daemonConnected(() => {
        useStore.getState().setDaemonConnected(true);
        void useStore.getState().ensureAllSessions();
      }),
    );
    unlisteners.push(on.daemonDisconnected(() => useStore.getState().setDaemonConnected(false)));
    unlisteners.push(on.daemonBuild((p) => useStore.getState().setDaemonStale(p.stale)));
    void (async () => {
      await st.init();
      const connected = await daemonStatus().catch(() => false);
      useStore.getState().setDaemonConnected(connected);
      if (connected) await useStore.getState().ensureAllSessions();
    })();
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, []);

  // Port/process monitor. lsof+ps cost real CPU, so: 2s while the ports panel is
  // on screen, 8s otherwise (status dots / port badges), paused while hidden.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const interval = () => {
      const s = useStore.getState();
      const active = s.config.projects.find((p) => p.id === s.config.activeProjectId);
      return active?.layout.portsOpen ? 2000 : 8000;
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
          s.setMonitor({ ports: s.monitor.ports, activity: s.monitor.activity, error: String(e) });
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

  // Keyboard shortcuts (capture phase so they win over xterm).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const s = useStore.getState();
      const project = s.config.projects.find((p) => p.id === s.config.activeProjectId);
      const key = e.key.toLowerCase();
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const target = s.config.projects[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          s.setActive(target.id);
        }
        return;
      }
      if (!project) return;
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
        {active ? <ProjectView key={active.id} project={active} /> : <EmptyState hasProjects={projectCount > 0} />}
      </main>
    </div>
  );
}
