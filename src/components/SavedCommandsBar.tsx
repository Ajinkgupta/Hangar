import { useState } from "react";
import { useStore } from "../store";
import { b64encode, pty } from "../lib/ipc";
import { uid, type Project, type SavedCommand } from "../lib/types";
import { terminals } from "../lib/terminals";

export function SavedCommandsBar({ project, shellSessionId }: { project: Project; shellSessionId: string }) {
  const setCommands = useStore((s) => s.setCommands);
  const setClaudeCommand = useStore((s) => s.setClaudeCommand);
  const updateLayout = useStore((s) => s.updateLayout);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SavedCommand[]>(project.commands);
  const [claudeCmd, setClaudeCmd] = useState(project.claudeCommand);

  const run = (command: string) => {
    updateLayout(project.id, { activeTab: "shell" });
    pty.write(shellSessionId, b64encode(command + "\r")).catch((e) => useStore.getState().setError(String(e)));
    requestAnimationFrame(() => terminals.focus(shellSessionId));
  };

  const startEdit = () => {
    setDraft(project.commands.length ? project.commands : [{ id: uid(), label: "", command: "" }]);
    setClaudeCmd(project.claudeCommand);
    setEditing(true);
  };
  const save = () => {
    const cleaned = draft
      .map((c) => ({ ...c, label: c.label.trim() || c.command.trim(), command: c.command.trim() }))
      .filter((c) => c.command);
    setCommands(project.id, cleaned);
    if (claudeCmd.trim()) setClaudeCommand(project.id, claudeCmd.trim());
    setEditing(false);
  };

  return (
    <div className="commands-bar">
      <div className="commands">
        {project.commands.length === 0 && !editing && <span className="hint">No saved commands yet — add e.g. npm run dev, pytest…</span>}
        {project.commands.map((c) => (
          <button key={c.id} className="cmd" title={c.command} onClick={() => run(c.command)}>
            ▶ {c.label}
          </button>
        ))}
      </div>
      <button className="ghost" onClick={editing ? () => setEditing(false) : startEdit}>
        {editing ? "close" : "edit"}
      </button>
      {editing && (
        <div className="commands-editor">
          <div className="row header">
            <span>Label</span>
            <span>Command (sent to the shell tab)</span>
            <span />
          </div>
          {draft.map((c, i) => (
            <div className="row" key={c.id}>
              <input
                placeholder="dev"
                value={c.label}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))}
              />
              <input
                placeholder="npm run dev"
                value={c.command}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, command: e.target.value } : d)))}
              />
              <button className="ghost danger" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div className="row">
            <button className="ghost" onClick={() => setDraft([...draft, { id: uid(), label: "", command: "" }])}>
              + add command
            </button>
          </div>
          <div className="row claude-row">
            <span>Claude launch command</span>
            <input value={claudeCmd} onChange={(e) => setClaudeCmd(e.target.value)} placeholder="claude" />
            <span />
          </div>
          <div className="row actions">
            <button className="primary" onClick={save}>Save</button>
            <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
