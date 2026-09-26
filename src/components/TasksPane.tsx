import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { tasks as taskApi, type TaskAction } from "../lib/ipc";
import type { Project, Task } from "../lib/types";
import { pollWhileVisible } from "../lib/polling";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Shared checklist: GUI and agents make atomic changes to individual tasks. */
export function TasksPane({ project }: { project: Project }) {
  const setError = useStore((s) => s.setError);
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const changing = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      if (changing.current) return;
      const version = ++generation.current;
      try {
        const next = await taskApi.apply(project.path, { op: "list" });
        if (version === generation.current) { setTasks(next); setLoaded(true); }
      } catch (e) { setError(`Could not load tasks: ${e}`); }
    };
    const stop = pollWhileVisible(refresh, () => 2000, document, (e) => setError(`Could not load tasks: ${e}`));
    return () => { mounted.current = false; ++generation.current; stop(); };
  }, [project.path, setError]);

  const mutate = async (action: TaskAction): Promise<boolean> => {
    if (changing.current) return false;
    changing.current = true;
    ++generation.current;
    setBusy(true);
    try {
      const next = await taskApi.apply(project.path, action);
      if (mounted.current) setTasks(next);
      return true;
    } catch (e) { setError(`Could not update tasks: ${e}`); return false; }
    finally { changing.current = false; if (mounted.current) setBusy(false); }
  };

  const add = async () => {
    const value = text.trim();
    if (value && await mutate({ op: "add", text: value })) setText("");
  };
  const copyInstructions = async () => {
    try {
      const cli = quote(await taskApi.cliPath());
      const prefix = `${cli} tasks --project ${quote(project.path)}`;
      await navigator.clipboard.writeText(`When I ask you to manage tasks for this project, use Hangar's shared task list through these shell commands. Only create or update tasks when requested. Keep task completion accurate; do not mark work done before verifying it.\n\nList: ${prefix} list\nAdd: ${prefix} add 'Task description'\nRename: ${prefix} rename TASK_ID 'Updated description'\nComplete: ${prefix} done TASK_ID\nReopen: ${prefix} reopen TASK_ID\nDelete (only if requested): ${prefix} delete TASK_ID\n\nCommands return JSON including task IDs. Use the real IDs returned by list/add. Changes appear live in Hangar. Do not edit Hangar's config or task storage files directly.`);
      setCopied(true);
    } catch (e) { setError(String(e)); }
  };
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const disabled = busy || !loaded;

  return (
    <div className="tasks-pane">
      <div className="tasks-heading"><div><h2>Project tasks</h2><p className="hint">A shared checklist for you and your agents.</p></div>
        {loaded && tasks.length > 0 && <span className="task-progress-label">{done.length} / {tasks.length} complete</span>}
      </div>
      {loaded && tasks.length > 0 && <progress className="task-progress" aria-label="Task completion" value={done.length} max={tasks.length} />}
      <div className="tasks-agent-help">
        <span>Give these instructions to your coding agent once so it can keep this project’s checklist in sync.</span>
        <button className="ghost small" onClick={() => void copyInstructions()}>{copied ? "Copied instructions" : "Copy agent instructions"}</button>
      </div>
      <form className="tasks-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input aria-label="New task" autoFocus placeholder="Add a task and press Enter…" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="primary" disabled={disabled || !text.trim()}>Add</button>
      </form>
      <div className="tasks-meta">
        <span>{loaded ? `${open.length} open · ${done.length} done · shared with agents` : "Loading tasks…"}</span>
        <span className="spacer" />
        {done.length > 0 && <>
          <button className="ghost small" onClick={() => setShowDone(!showDone)}>{showDone ? "hide done" : "show done"}</button>
          <button className="ghost small danger" disabled={disabled} onClick={() => void mutate({ op: "clear_done" })}>clear done</button>
        </>}
      </div>
      <ul className="tasks">
        {[...open, ...(showDone ? done : [])].map((t) => <TaskRow key={t.id} task={t} disabled={disabled} mutate={mutate} />)}
        {loaded && tasks.length === 0 && <li className="muted pad">Your next step starts here. Add a task above, or share the instructions with your agent.</li>}
      </ul>
    </div>
  );
}

function TaskRow({ task, disabled, mutate }: { task: Task; disabled: boolean; mutate: (action: TaskAction) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.text);
  const commit = async () => {
    if (text.trim() && await mutate({ op: "update", id: task.id, text: text.trim() })) setEditing(false);
  };
  return (
    <li className={"task" + (task.done ? " done" : "")}>
      <input type="checkbox" aria-label={`Mark ${task.text} ${task.done ? "incomplete" : "complete"}`} disabled={disabled} checked={task.done} onChange={(e) => void mutate({ op: "update", id: task.id, done: e.target.checked })} />
      {editing ? <>
        <input className="task-edit" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") setEditing(false);
        }} />
        <button className="ghost small" disabled={disabled || !text.trim()} onClick={() => void commit()}>save</button>
        <button className="ghost small" onClick={() => setEditing(false)}>cancel</button>
      </> : <span className="task-text" onDoubleClick={() => { setText(task.text); setEditing(true); }} title="double-click to edit">{task.text}</span>}
      {!editing && <button className="ghost small" disabled={disabled} onClick={() => { setText(task.text); setEditing(true); }}>edit</button>}
      <button className="ghost small" title="Copy task" onClick={() => void navigator.clipboard.writeText(task.text).catch((e) => useStore.getState().setError(String(e)))}>copy</button>
      <button className="ghost small danger" disabled={disabled} onClick={() => void mutate({ op: "delete", id: task.id })} title="Delete">✕</button>
    </li>
  );
}
