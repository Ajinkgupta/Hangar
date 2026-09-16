import { useState } from "react";
import { useStore } from "../store";
import { killProcess, type PortRow } from "../lib/ipc";
import { projectOfSession, type Project } from "../lib/types";

export function PortsPanel({ project }: { project: Project }) {
  const monitor = useStore((s) => s.monitor);
  const showAll = useStore((s) => s.showAllPorts);
  const toggle = useStore((s) => s.toggleShowAllPorts);
  const projects = useStore((s) => s.config.projects);
  const setError = useStore((s) => s.setError);
  const [pendingKill, setPendingKill] = useState<Record<number, number>>({});

  const nameOf = (sid: string | null) => {
    if (!sid) return null;
    const p = projects.find((x) => x.id === projectOfSession(sid));
    if (!p) return sid;
    const t = p.terminals.find((t) => t.id === sid.split(":")[1]);
    return `${p.name} · ${t?.name ?? "terminal"}`;
  };

  const rows = showAll ? monitor.ports : monitor.ports.filter((r) => r.session_id !== null);
  const isThisProject = (r: PortRow) => r.session_id !== null && projectOfSession(r.session_id) === project.id;

  const kill = async (r: PortRow) => {
    const now = Date.now();
    const force = pendingKill[r.pid] !== undefined && now - pendingKill[r.pid] < 5000;
    try {
      await killProcess(r.pid, force);
      setPendingKill({ ...pendingKill, [r.pid]: now });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="ports-panel">
      <div className="ports-header">
        <span className="title">Ports</span>
        <div className="seg">
          <button className={!showAll ? "on" : ""} onClick={() => showAll && toggle()}>Hangar projects</button>
          <button className={showAll ? "on" : ""} onClick={() => !showAll && toggle()}>All</button>
        </div>
        <span className="spacer" />
        <span className="hint">{monitor.error ? `monitor error: ${monitor.error}` : `${rows.length} listening`}</span>
      </div>
      <div className="ports-table-wrap">
        <table className="ports-table">
          <thead>
            <tr>
              <th>Port</th>
              <th>Process</th>
              <th>PID</th>
              <th>Project</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {showAll ? "Nothing is listening." : "No ports owned by Hangar projects yet. Start a dev server in one of the terminals."}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const pending = pendingKill[r.pid] !== undefined && Date.now() - pendingKill[r.pid] < 5000;
              return (
                <tr key={`${r.port}-${r.pid}`} className={(r.conflict ? "conflict " : "") + (isThisProject(r) ? "mine" : "")}>
                  <td className="mono">{r.port}{r.conflict && <span className="conflict-tag" title="More than one process listens on this port">conflict</span>}</td>
                  <td className="mono" title={r.addr}>{r.process}</td>
                  <td className="mono">{r.pid}</td>
                  <td>{nameOf(r.session_id) ?? <span className="muted">—</span>}</td>
                  <td className="actions">
                    <button className={pending ? "danger solid" : "danger"} onClick={() => void kill(r)} title={pending ? "Still alive — send SIGKILL" : "Send SIGTERM"}>
                      {pending ? "force kill" : "kill"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
