import { Group, Panel, Separator } from "react-resizable-panels";
import { useStore } from "../store";
import { sessionId, type Project, type Tab } from "../lib/types";
import { TerminalPane } from "./TerminalPane";
import { SavedCommandsBar } from "./SavedCommandsBar";
import { PortsPanel } from "./PortsPanel";
import { BrowserPane } from "./BrowserPane";
import { ChangesPane } from "./ChangesPane";
import { projectPort } from "../lib/status";

const TABS: { id: Tab; label: string }[] = [
  { id: "claude", label: "claude" },
  { id: "shell", label: "shell" },
  { id: "changes", label: "changes" },
];

export function ProjectView({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const stop = useStore((s) => s.stopSessions);
  const port = useStore((s) => projectPort(project.id, s.monitor));
  const { layout } = project;
  const set = (patch: Parameters<typeof updateLayout>[1]) => updateLayout(project.id, patch);
  const sid = (kind: "claude" | "shell") => sessionId(project.id, kind);

  const openBrowser = () => {
    const patch: Partial<typeof layout> = { browserOpen: !layout.browserOpen };
    if (!layout.browserOpen && !layout.browserUrl && port !== null) patch.browserUrl = `http://localhost:${port}`;
    set(patch);
  };

  const mainContent = (
    <div className="main-panel">
      <div className="tab-content">
        <div className="tab-pane" style={{ display: layout.activeTab === "claude" ? "flex" : "none" }}>
          <TerminalPane project={project} kind="claude" visible={layout.activeTab === "claude"} />
        </div>
        <div className="tab-pane" style={{ display: layout.activeTab === "shell" ? "flex" : "none" }}>
          <TerminalPane project={project} kind="shell" visible={layout.activeTab === "shell"} />
        </div>
        {layout.activeTab === "changes" && (
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
          {TABS.map((t) => (
            <button key={t.id} className={layout.activeTab === t.id ? "tab active" : "tab"} onClick={() => set({ activeTab: t.id })}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button className={layout.portsOpen ? "on" : ""} onClick={() => set({ portsOpen: !layout.portsOpen })} title="Toggle port monitor">
            ports
          </button>
          <button className={layout.browserOpen ? "on" : ""} onClick={openBrowser} title="Toggle browser preview">
            browser{port !== null ? ` :${port}` : ""}
          </button>
          <button
            onClick={() => set({ splitDirection: layout.splitDirection === "horizontal" ? "vertical" : "horizontal" })}
            title="Browser beside / below terminal"
            disabled={!layout.browserOpen}
          >
            {layout.splitDirection === "horizontal" ? "⇔" : "⇕"}
          </button>
          <button className="danger" onClick={() => void stop(project.id)} title="Stop both terminal sessions">
            stop
          </button>
        </div>
      </header>
      <SavedCommandsBar project={project} shellSessionId={sid("shell")} />
      {layout.browserOpen ? (
        <Group
          key={layout.splitDirection}
          orientation={layout.splitDirection}
          className="split"
          defaultLayout={{ main: layout.splitRatio * 100, browser: (1 - layout.splitRatio) * 100 }}
          onLayoutChanged={(l) => {
            const r = (l.main ?? 60) / 100;
            if (Math.abs(r - layout.splitRatio) > 0.005) set({ splitRatio: Math.min(0.8, Math.max(0.2, r)) });
          }}
        >
          <Panel id="main" minSize="20">
            {mainContent}
          </Panel>
          <Separator className="separator" />
          <Panel id="browser" minSize="20">
            <BrowserPane project={project} />
          </Panel>
        </Group>
      ) : (
        <div className="split">{mainContent}</div>
      )}
    </div>
  );
}
