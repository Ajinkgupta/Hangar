import { AddProjectButton } from "./AddProject";

export function EmptyState({ hasProjects }: { hasProjects: boolean }) {
  return (
    <div className="empty">
      <div className="empty-logo">H</div>
      <h1>Hangar</h1>
      <p>{hasProjects ? "Pick a project in the sidebar." : "Add a project folder to get a persistent Claude Code terminal, a shell, live ports, and a preview."}</p>
      {!hasProjects && <AddProjectButton large />}
    </div>
  );
}
