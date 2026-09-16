import { useState } from "react";
import { useStore } from "../store";

/** Creates `git worktree add -b <branch> ../<repo>-<branch>` and adds it as a project. */
export function WorktreeDialog({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.config.projects.find((p) => p.id === projectId));
  const addWorktree = useStore((s) => s.addWorktree);
  const close = () => useStore.getState().setWorktreeFor(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  const safe = branch.trim().replace(/\//g, "-");
  const parent = project.path.replace(/\/[^/]+$/, "");
  const base = project.path.split("/").pop();
  const submit = async () => {
    if (!branch.trim() || busy) return;
    setBusy(true);
    await addWorktree(projectId, branch.trim());
    setBusy(false);
  };
  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New worktree for {project.name}</h3>
        <p className="hint">A second checkout of the same repo, so another agent can work on it in parallel.</p>
        <label>
          Branch
          <input
            autoFocus
            placeholder="feature/login"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") close();
            }}
          />
        </label>
        <p className="hint mono">
          → {parent}/{base}-{safe || "<branch>"}
        </p>
        <div className="dialog-actions">
          <button className="ghost" onClick={close}>Cancel</button>
          <button className="primary" disabled={!branch.trim() || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create & add"}
          </button>
        </div>
      </div>
    </div>
  );
}
