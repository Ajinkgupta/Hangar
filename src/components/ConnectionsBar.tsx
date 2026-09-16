import { useStore } from "../store";

/** Row of saved connections shown above the SSH terminals. */
export function ConnectionsBar() {
  const connections = useStore((s) => s.config.connections);
  const run = useStore((s) => s.runConnection);
  const setEditor = useStore((s) => s.setConnectionEditor);
  return (
    <div className="commands-bar">
      <div className="commands">
        {connections.length === 0 && <span className="hint">No saved connections yet.</span>}
        {connections.map((c) => (
          <button key={c.id} className="cmd" title={c.command} onClick={() => void run(c.id)}>
            <span className="play">⇄</span> {c.name}
          </button>
        ))}
      </div>
      <button className="ghost small" onClick={() => setEditor("new")}>
        + add connection
      </button>
    </div>
  );
}
