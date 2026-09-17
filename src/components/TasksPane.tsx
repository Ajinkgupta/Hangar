import { useState } from "react";
import { useStore } from "../store";
import { uid, type Project, type Task } from "../lib/types";

/** Per-project checklist, stored with the project config. */
export function TasksPane({ project }: { project: Project }) {
  const setTasks = useStore((s) => s.setTasks);
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(true);
  const tasks = project.tasks;
  const save = (t: Task[]) => setTasks(project.id, t);

  const add = () => {
    const v = text.trim();
    if (!v) return;
    save([{ id: uid(), text: v, done: false, createdAt: Date.now() }, ...tasks]);
    setText("");
  };
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="tasks-pane">
      <div className="tasks-add">
        <input
          autoFocus
          placeholder="Add a task and press Enter… (e.g. 'review PR #42', 'ask claude to add tests')"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button className="primary" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
      <div className="tasks-meta">
        <span>{open.length} open · {done.length} done</span>
        <span className="spacer" />
        {done.length > 0 && (
          <>
            <button className="ghost small" onClick={() => setShowDone(!showDone)}>{showDone ? "hide done" : "show done"}</button>
            <button className="ghost small danger" onClick={() => save(open)}>clear done</button>
          </>
        )}
      </div>
      <ul className="tasks">
        {open.map((t) => (
          <TaskRow key={t.id} task={t} tasks={tasks} save={save} />
        ))}
        {showDone && done.map((t) => <TaskRow key={t.id} task={t} tasks={tasks} save={save} />)}
        {tasks.length === 0 && <li className="muted pad">No tasks yet.</li>}
      </ul>
    </div>
  );
}

function TaskRow({ task, tasks, save }: { task: Task; tasks: Task[]; save: (t: Task[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.text);
  const update = (patch: Partial<Task>) => save(tasks.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
  const commit = () => {
    if (text.trim()) update({ text: text.trim() });
    setEditing(false);
  };
  return (
    <li className={"task" + (task.done ? " done" : "")}>
      <input type="checkbox" checked={task.done} onChange={(e) => update({ done: e.target.checked })} />
      {editing ? (
        <input
          className="task-edit"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="task-text" onDoubleClick={() => setEditing(true)} title="double-click to edit">
          {task.text}
        </span>
      )}
      <button className="ghost small" title="Copy to clipboard (paste into an agent prompt)" onClick={() => void navigator.clipboard.writeText(task.text)}>
        copy
      </button>
      <button className="ghost small danger" onClick={() => save(tasks.filter((t) => t.id !== task.id))} title="Delete">✕</button>
    </li>
  );
}
