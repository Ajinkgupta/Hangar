import { AddProjectButton } from "./AddProject";

export function EmptyState({ hasProjects }: { hasProjects: boolean }) {
  return (
    <div className="empty">
      <img src="/logo.svg" alt="Hangar" className="empty-logo" />
      <h1>Hangar</h1>
      <p>{hasProjects ? "Pick a project in the sidebar." : "Add a project folder to get persistent terminals, one-click commands, live ports, and a GitHub-style diff view."}</p>
      {!hasProjects && <AddProjectButton large />}
    </div>
  );
}
