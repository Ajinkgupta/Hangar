import { selectActiveProject, useStore } from "../store";

export function WorkspaceBar({ sidebarOpen, toggleSidebar }: { sidebarOpen: boolean; toggleSidebar: () => void }) {
  const active = useStore(selectActiveProject);
  const overview = useStore((s) => s.view === "overview");
  const connected = useStore((s) => s.daemonConnected);
  const waiting = useStore((s) => Object.keys(s.attention).length);
  return <div className="workspace-bar">
    <button className="ghost workspace-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar" aria-expanded={sidebarOpen} title="Toggle sidebar (⌘B)">◧</button>
    <button className="workspace-search" onClick={() => useStore.getState().setPaletteOpen(true)} title="Search projects, terminals, and views">
      <span>{overview ? "Workspace overview" : active?.name ?? "Hangar"}<span className="workspace-search-hint"> · Search workspace</span></span><kbd>⌘P</kbd>
    </button>
    <button className="ghost small workspace-status" onClick={() => useStore.getState().setView("overview")} title="Open workspace overview">
      <span className={`dot ${!connected ? "error" : waiting ? "attention" : "running"}`} />
      {!connected ? "Reconnecting" : waiting ? `${waiting} need attention` : "Connected"}
    </button>
  </div>;
}
