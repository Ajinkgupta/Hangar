import { useState } from "react";
import { useStore } from "../store";
import { b64encode, pty } from "../lib/ipc";
import { CHANGES_TAB, sessionId, uid, type Project, type SavedCommand } from "../lib/types";
import { terminals } from "../lib/terminals";

/** Row of one-click commands. Each sends its text into the active terminal tab. */
export function SavedCommandsBar({ project }: { project: Project }) {
  const setCommands = useStore((s) => s.setCommands);
  const updateLayout = useStore((s) => s.updateLayout);
  const addTerminal = useStore((s) => s.addTerminal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SavedCommand[]>(project.commands);

  const run = async (command: string, inNewTab = false) => {
    let terminalId = project.layout.activeTab;
    if (inNewTab || terminalId === CHANGES_TAB || !project.terminals.some((t) => t.id === terminalId)) {
      terminalId = inNewTab ? await addTerminal(project.id, command.split(" ")[0]) : project.terminals[0]?.id ?? "";
      if (!terminalId) terminalId = await addTerminal(project.id);
      updateLayout(project.id, { activeTab: terminalId });
      // give the new PTY a moment to spawn its shell before typing into it
      await new Promise((r) => setTimeout(r, inNewTab ? 250 : 0));
    }
    const sid = sessionId(project.id, terminalId);
    pty.write(sid, b64encode(command + "\r")).catch((e) => useStore.getState().setError(String(e)));
    requestAnimationFrame(() => terminals.focus(sid));
  };

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
          <button
            key={c.id}
            className="cmd"
            title={`${c.command}\nclick: run in current terminal · ⌥-click: run in a new terminal`}
            onClick={(e) => void run(c.command, e.altKey)}
          >
            <span className="play">▶</span> {c.label}
          </button>
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
              <input
                placeholder="dev"
                value={c.label}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))}
              />
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
