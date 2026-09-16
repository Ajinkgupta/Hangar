import { useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ProjectView } from "./components/ProjectView";
import { EmptyState } from "./components/EmptyState";
import { selectActiveProject, useStore } from "./store";
import { daemonStatus, monitorTick, on } from "./lib/ipc";
import { terminals } from "./lib/terminals";

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const daemonConnected = useStore((s) => s.daemonConnected);
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

  // Port/process monitor: every 2s while visible.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
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
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  if (!loaded) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {!daemonConnected && <div className="banner warn">Reconnecting to session daemon…</div>}
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
