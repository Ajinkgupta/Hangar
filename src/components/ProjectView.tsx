import { useState } from "react";
import { useStore } from "../store";
import { CHANGES_TAB, sessionId, type Project, type TerminalTab } from "../lib/types";
import { TerminalPane } from "./TerminalPane";
import { SavedCommandsBar } from "./SavedCommandsBar";
import { PortsPanel } from "./PortsPanel";
import { ChangesPane } from "./ChangesPane";
import { ConnectionsBar } from "./ConnectionsBar";

export function ProjectView({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const stop = useStore((s) => s.stopSessions);
  const addTerminal = useStore((s) => s.addTerminal);
  const changed = useStore((s) => s.gitSummary[project.path]?.files ?? 0);
  const branch = useStore((s) => s.gitSummary[project.path]?.branch ?? "");
  const { layout } = project;
  const isSsh = project.kind === "ssh";
  const set = (patch: Parameters<typeof updateLayout>[1]) => updateLayout(project.id, patch);

  const mainContent = (
    <div className="main-panel">
      <div className="tab-content">
        {project.terminals.map((t) => (
          <div key={t.id} className="tab-pane" style={{ display: layout.activeTab === t.id ? "flex" : "none" }}>
            <TerminalPane project={project} tab={t} visible={layout.activeTab === t.id} />
          </div>
        ))}
        {layout.activeTab === CHANGES_TAB && !isSsh && (
          <div className="tab-pane">
            <ChangesPane project={project} />
          </div>
        )}
        {isSsh && project.terminals.length === 0 && (
          <div className="empty small">
            <p>Pick a connection in the sidebar, or add one with +. Each opens here as its own terminal tab.</p>
          </div>
        )}
      </div>
      {layout.portsOpen && !isSsh && <PortsPanel project={project} />}
    </div>
  );

  return (
    <div className="project-view">
      <header className="project-header">
        <div className="project-title">
          <span className="project-name">
            {project.name}
            {branch && !isSsh && (
              <span className="branch-chip" title="current git branch">
                ⎇ {branch}
              </span>
            )}
          </span>
          <span className="project-path" title={project.path}>{isSsh ? "saved ssh / bastion connections" : project.path}</span>
        </div>
        <nav className="tabs">
          {project.terminals.map((t) => (
            <TerminalTabButton
              key={t.id}
              project={project}
              tab={t}
              active={layout.activeTab === t.id}
              closable={project.terminals.length > 1}
            />
          ))}
          <button className="tab add" title="New terminal (⌘T)" onClick={() => void addTerminal(project.id)}>
            +
          </button>
          {!isSsh && (
            <>
              <span className="tab-gap" />
              <button className={layout.activeTab === CHANGES_TAB ? "tab active changes" : "tab changes"} onClick={() => set({ activeTab: CHANGES_TAB })}>
                ⎇ changes{changed > 0 && <span className="count">{changed}</span>}
              </button>
            </>
          )}
        </nav>
        <div className="header-actions">
          {!isSsh && (
            <button className={layout.portsOpen ? "on" : ""} onClick={() => set({ portsOpen: !layout.portsOpen })} title="Toggle port monitor">
              ports
            </button>
          )}
          <button className="danger" onClick={() => void stop(project.id)} title="Stop all terminals of this project">
            stop
          </button>
        </div>
      </header>
      {isSsh ? <ConnectionsBar /> : <SavedCommandsBar project={project} />}
      <div className="split">{mainContent}</div>
    </div>
  );
}

function TerminalTabButton({ project, tab, active, closable }: { project: Project; tab: TerminalTab; active: boolean; closable: boolean }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const sid = sessionId(project.id, tab.id);
  const session = useStore((s) => s.sessions[sid]);
  const busy = useStore((s) => (s.monitor.activity[sid] ?? 0) > 0);
  const agent = useStore((s) => s.monitor.agents[sid] ?? null);
  const attention = useStore((s) => sid in s.attention);
  const streaming = useStore((s) => Date.now() - (s.lastOutput[sid] ?? 0) < 3000);
  const connecting = useStore((s) => s.connecting[sid] === "running");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(tab.name);

  if (renaming) {
    const commit = () => {
      renameTerminal(project.id, tab.id, name);
      setRenaming(false);
    };
    return (
      <input
        className="tab-rename"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setRenaming(false);
        }}
      />
    );
  }
  return (
    <button
      className={"tab" + (active ? " active" : "") + (session && !session.alive ? " dead" : "") + (attention ? " attention" : "")}
      onClick={() => updateLayout(project.id, { activeTab: tab.id })}
      onDoubleClick={() => {
        setName(tab.name);
        setRenaming(true);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && closable) void closeTerminal(project.id, tab.id);
      }}
      title="double-click to rename · ⌘W or middle-click to close · ⌘⇧] next tab"
    >
      <span className={"tab-dot" + (attention ? " attention" : streaming ? " streaming" : busy ? " busy" : "")} />
      {tab.name}
      {agent && <span className="tab-agent">{agent}</span>}
      {connecting && <span className="tab-agent">auto-login…</span>}
      {closable && (
        <span
          className="tab-close"
          onClick={(e) => {
            e.stopPropagation();
            void closeTerminal(project.id, tab.id);
          }}
        >
          ×
        </span>
      )}
    </button>
  );
}
