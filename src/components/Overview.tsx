import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { deriveStatus, projectPort } from "../lib/status";
import { sessionId, type Project } from "../lib/types";
import { pollWhileVisible } from "../lib/polling";
import { AddProjectButton } from "./AddProject";
import { openUrl, pty } from "../lib/ipc";

/** Every project at a glance: status, agent, ports, changes, and the tail of its terminal. */
export function Overview() {
  const projects = useStore(useShallow((s) => s.config.projects.filter((p) => p.kind !== "ssh")));
  const sessions = useStore((s) => s.sessions);
  const attention = useStore((s) => s.attention);
  const monitor = useStore((s) => s.monitor);
  const statuses = projects.map((p) => deriveStatus(p.id, sessions, monitor, attention));
  return (
    <div className="overview">
      <header className="overview-header">
        <div><h2>Workspace overview</h2><p className="hint">Your projects, coding agents, and running terminals in one place.</p></div>
        <span className="spacer" /><span className="hint"><kbd>⌘0</kbd> switch view</span>
      </header>
      {projects.length > 0 ? <div className="overview-stats">
        <div><strong>{projects.length}</strong><span>Projects</span></div>
        <div className="attention"><strong>{statuses.filter((s) => s === "attention").length}</strong><span>Need attention</span></div>
        <div><strong>{statuses.filter((s) => s === "running").length}</strong><span>Running</span></div>
        <div><strong>{statuses.filter((s) => s === "error").length}</strong><span>With ended terminals</span></div>
      </div> : <div className="empty"><h2>Your workspace starts here</h2><p>Add a project to keep your agents, files, and terminals together.</p><AddProjectButton large /></div>}
      <div className="overview-grid">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const setActive = useStore((s) => s.setActive);
  const updateLayout = useStore((s) => s.updateLayout);
  const status = useStore((s) => deriveStatus(project.id, s.sessions, s.monitor, s.attention));
  const port = useStore((s) => projectPort(project.id, s.monitor));
  const summary = useStore((s) => s.gitSummary[project.path]);
  const agents = useStore(useShallow((s) => Object.entries(s.monitor.agents).filter(([sid]) => sid.startsWith(project.id + ":")).map(([sid, a]) => `${sid}=${a}`))).map(
    (x) => x.split("=") as [string, string],
  );
  const attention = useStore(useShallow((s) => Object.keys(s.attention).filter((sid) => sid.startsWith(project.id + ":"))));
  const [tail, setTail] = useState<string[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const connected = useStore((s) => s.daemonConnected);
  const lastPreview = useRef<{ sid: string; stamp: number | undefined } | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  // The terminal worth watching: one needing attention, else one running an agent,
  // else the active tab, else the first.
  const focusTerminalId =
    attention[0]?.split(":")[1] ??
    agents[0]?.[0].split(":")[1] ??
    (project.terminals.find((t) => t.id === project.layout.activeTab)?.id ?? project.terminals[0]?.id);
  const focusTab = project.terminals.find((t) => t.id === focusTerminalId);
  const focusSid = focusTab ? sessionId(project.id, focusTab.id) : null;
  const lastOutput = useStore((s) => focusSid ? s.lastOutput[focusSid] : undefined);
  const streaming = lastOutput ? Date.now() - lastOutput < 3000 : false;

  useEffect(() => { setTail([]); lastPreview.current = null; }, [focusSid, connected]);
  useEffect(() => {
    if (!focusSid || !inView || !connected) return;
    let stopped = false;
    const cancel = pollWhileVisible(async () => {
      const stamp = useStore.getState().lastOutput[focusSid];
      if (lastPreview.current?.sid === focusSid && lastPreview.current.stamp === stamp) return;
      const lines = await pty.tail(focusSid, 7);
      if (stopped) return;
      lastPreview.current = { sid: focusSid, stamp };
      setTail((previous) => previous.length === lines.length && previous.every((line, i) => line === lines[i]) ? previous : lines);
    }, () => 3000);
    return () => { stopped = true; cancel(); };
  }, [focusSid, inView, connected]);

  const openIt = () => {
    setActive(project.id);
    if (focusTab) updateLayout(project.id, { activeTab: focusTab.id });
  };

  return (
    <div ref={cardRef} className={"card " + status}>
      <button className="card-open" onClick={openIt} aria-label={`Open ${project.name}`} />
      <div className="card-head">
        <span className={"dot " + status} />
        <span className="card-name">{project.name}</span>
        {summary?.branch && <span className="meta branch">{summary.branch}</span>}
        <span className="spacer" />
        {port !== null && (
          <button
            className="port-badge"
            aria-label={`Open localhost port ${port}`}
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(`http://localhost:${port}`);
            }}
          >
            :{port}
          </button>
        )}
      </div>
      <div className="card-path" title={project.path}>{project.path}</div>
      <div className="card-meta">
        {status === "attention" && <span className="meta attention">needs you</span>}
        {agents.map(([sid, a]) => (
          <span key={sid} className="meta agent">
            {a} · {project.terminals.find((t) => t.id === sid.split(":")[1])?.name ?? "terminal"}
          </span>
        ))}
        {agents.length === 0 && status !== "attention" && <span className="meta">{status === "running" ? "running" : status === "error" ? "terminal ended" : "idle"}</span>}
        {summary?.is_repo && summary.files > 0 && (
          <span className="meta changes">
            {summary.files} files <span className="add">+{summary.additions}</span> <span className="del">−{summary.deletions}</span>
          </span>
        )}
        {streaming && <span className="meta live">● live</span>}
      </div>
      <pre className="card-tail">
        {focusTab && <span className="tail-label">{focusTab.name}</span>}
        {tail.length ? tail.join("\n") : <span className="muted">no output yet</span>}
      </pre>
    </div>
  );
}
