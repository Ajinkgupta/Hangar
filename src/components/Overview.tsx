import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { deriveStatus, projectPort } from "../lib/status";
import { CHANGES_TAB, sessionId, type Project } from "../lib/types";
import { openUrl, pty } from "../lib/ipc";

/** Every project at a glance: status, agent, ports, changes, and the tail of its terminal. */
export function Overview() {
  const projects = useStore(useShallow((s) => s.config.projects.filter((p) => p.kind !== "ssh")));
  return (
    <div className="overview">
      <header className="overview-header">
        <h2>Overview</h2>
        <span className="hint">{projects.length} projects · click a card to open it · ⌘0 toggles</span>
      </header>
      {projects.length === 0 && <div className="muted pad">No projects yet.</div>}
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
  const lastOutput = useStore((s) => s.lastOutput);
  const [tail, setTail] = useState<string[]>([]);

  // The terminal worth watching: one needing attention, else one running an agent,
  // else the active tab, else the first.
  const focusTerminalId =
    attention[0]?.split(":")[1] ??
    agents[0]?.[0].split(":")[1] ??
    (project.layout.activeTab !== CHANGES_TAB ? project.layout.activeTab : project.terminals[0]?.id);
  const focusTab = project.terminals.find((t) => t.id === focusTerminalId);
  const focusSid = focusTab ? sessionId(project.id, focusTab.id) : null;
  const streaming = focusSid ? Date.now() - (lastOutput[focusSid] ?? 0) < 3000 : false;

  useEffect(() => {
    if (!focusSid) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = setTimeout(tick, 3000);
        return;
      }
      const lines = await pty.tail(focusSid, 7).catch(() => [] as string[]);
      if (!stopped) setTail(lines);
      timer = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [focusSid]);

  const openIt = () => {
    setActive(project.id);
    if (focusTab) updateLayout(project.id, { activeTab: focusTab.id });
  };

  return (
    <div className={"card " + status} onClick={openIt}>
      <div className="card-head">
        <span className={"dot " + status} />
        <span className="card-name">{project.name}</span>
        {summary?.branch && <span className="meta branch">{summary.branch}</span>}
        <span className="spacer" />
        {port !== null && (
          <span
            className="port-badge"
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(`http://localhost:${port}`);
            }}
          >
            :{port}
          </span>
        )}
      </div>
      <div className="card-meta">
        {status === "attention" && <span className="meta attention">needs you</span>}
        {agents.map(([sid, a]) => (
          <span key={sid} className="meta agent">
            {a} · {project.terminals.find((t) => t.id === sid.split(":")[1])?.name ?? "terminal"}
          </span>
        ))}
        {agents.length === 0 && status !== "attention" && <span className="meta">{status === "running" ? "running" : "idle"}</span>}
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
