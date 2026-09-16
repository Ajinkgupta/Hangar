import { useState } from "react";
import { useStore } from "../store";
import { CHANGES_TAB, sessionId, type Project, type TerminalTab } from "../lib/types";
import { TerminalPane } from "./TerminalPane";
import { SavedCommandsBar } from "./SavedCommandsBar";
import { PortsPanel } from "./PortsPanel";
import { ChangesPane } from "./ChangesPane";

export function ProjectView({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const stop = useStore((s) => s.stopSessions);
  const addTerminal = useStore((s) => s.addTerminal);
  const { layout } = project;
  const set = (patch: Parameters<typeof updateLayout>[1]) => updateLayout(project.id, patch);

  const mainContent = (
    <div className="main-panel">
      <div className="tab-content">
        {project.terminals.map((t) => (
          <div key={t.id} className="tab-pane" style={{ display: layout.activeTab === t.id ? "flex" : "none" }}>
            <TerminalPane project={project} tab={t} visible={layout.activeTab === t.id} />
          </div>
        ))}
        {layout.activeTab === CHANGES_TAB && (
          <div className="tab-pane">
            <ChangesPane project={project} />
          </div>
        )}
      </div>
      {layout.portsOpen && <PortsPanel project={project} />}
    </div>
  );

  return (
    <div className="project-view">
      <header className="project-header">
        <div className="project-title">
          <span className="project-name">{project.name}</span>
          <span className="project-path" title={project.path}>{project.path}</span>
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
          <span className="tab-gap" />
          <button className={layout.activeTab === CHANGES_TAB ? "tab active changes" : "tab changes"} onClick={() => set({ activeTab: CHANGES_TAB })}>
            ⎇ changes
          </button>
        </nav>
        <div className="header-actions">
          <button className={layout.portsOpen ? "on" : ""} onClick={() => set({ portsOpen: !layout.portsOpen })} title="Toggle port monitor">
            ports
          </button>
          <button className="danger" onClick={() => void stop(project.id)} title="Stop all terminals of this project">
            stop
          </button>
        </div>
      </header>
      <SavedCommandsBar project={project} />
      <div className="split">{mainContent}</div>
    </div>
  );
}

function TerminalTabButton({ project, tab, active, closable }: { project: Project; tab: TerminalTab; active: boolean; closable: boolean }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const session = useStore((s) => s.sessions[sessionId(project.id, tab.id)]);
  const busy = useStore((s) => (s.monitor.activity[sessionId(project.id, tab.id)] ?? 0) > 0);
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
      className={"tab" + (active ? " active" : "") + (session && !session.alive ? " dead" : "")}
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
      <span className={"tab-dot" + (busy ? " busy" : "")} />
      {tab.name}
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
