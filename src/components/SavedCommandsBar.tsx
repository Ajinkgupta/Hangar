import { useState } from "react";
import { useStore } from "../store";
import { sessionId, uid, type Project, type SavedCommand } from "../lib/types";

/** Row of one-click commands. Each command owns a terminal tab: click runs it there, or
 *  switches to it if it is still running. ⌥-click always opens a fresh tab. */
export function SavedCommandsBar({ project }: { project: Project }) {
  const setCommands = useStore((s) => s.setCommands);
  const run = useStore((s) => s.runSavedCommand);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SavedCommand[]>(project.commands);

  const startEdit = () => {
    setDraft(project.commands.length ? project.commands : [{ id: uid(), label: "", command: "" }]);
    setEditing(true);
  };
  const save = () => {
    const cleaned = draft
      .map((c) => ({ ...c, label: c.label.trim() || c.command.trim(), command: c.command.trim() }))
      .filter((c) => c.command);
    setCommands(project.id, cleaned);
    setEditing(false);
  };

  return (
    <div className="commands-bar">
      <div className="commands">
        {project.commands.length === 0 && !editing && <span className="hint">No saved commands — add e.g. claude --resume, npm run dev, pytest…</span>}
        {project.commands.map((c) => (
          <CommandButton key={c.id} project={project} command={c} onRun={(force) => void run(project.id, c.id, force)} />
        ))}
      </div>
      <button className="ghost small" onClick={editing ? () => setEditing(false) : startEdit}>
        {editing ? "close" : "edit commands"}
      </button>
      {editing && (
        <div className="commands-editor">
          <div className="row header">
            <span>Label</span>
            <span>Command</span>
            <span />
          </div>
          {draft.map((c, i) => (
            <div className="row" key={c.id}>
              <input placeholder="dev" value={c.label} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))} />
              <input
                placeholder="npm run dev"
                value={c.command}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, command: e.target.value } : d)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
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
          <div className="row actions">
            <button className="primary" onClick={save}>Save</button>
            <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommandButton({ project, command, onRun }: { project: Project; command: SavedCommand; onRun: (forceNewTab: boolean) => void }) {
  const ownedId = project.commandRuns[command.id];
  const tab = project.terminals.find((t) => t.id === ownedId);
  const sid = tab ? sessionId(project.id, tab.id) : null;
  const running = useStore((s) => (sid ? (s.monitor.activity[sid] ?? 0) > 0 && s.sessions[sid]?.alive !== false : false));
  const isActive = tab ? project.layout.activeTab === tab.id : false;
  return (
    <button
      className={"cmd" + (running ? " running" : "") + (isActive ? " current" : "")}
      title={`${command.command}\n${running ? "running — click to switch to its tab" : "click: run in its own tab"} · ⌥-click: run in a new tab`}
      onClick={(e) => onRun(e.altKey)}
    >
      <span className={"play" + (running ? " live" : "")}>{running ? "●" : "▶"}</span> {command.label}
    </button>
  );
}
