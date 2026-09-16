import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";

export function AddProjectButton({ large = false }: { large?: boolean }) {
  const addProject = useStore((s) => s.addProject);
  const setError = useStore((s) => s.setError);
  const [pasting, setPasting] = useState(false);
  const [path, setPath] = useState("");

  const pick = async () => {
    try {
      const dir = await open({ directory: true, multiple: false, title: "Add project folder" });
      if (typeof dir === "string" && dir) await addProject(dir);
    } catch (e) {
      setError(`Could not open folder picker: ${e}`);
      setPasting(true);
    }
  };
  const submitPath = async () => {
    const p = path.trim().replace(/^~/, homeDir());
    if (!p) return;
    await addProject(p);
    setPath("");
    setPasting(false);
  };

  if (pasting) {
    return (
      <div className={"add-path" + (large ? " large" : "")}>
        <input
          autoFocus
          placeholder="/path/to/project"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitPath();
            if (e.key === "Escape") setPasting(false);
          }}
        />
        <div className="add-path-actions">
          <button className="primary small" onClick={() => void submitPath()}>Add</button>
          <button className="ghost small" onClick={() => setPasting(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className={"add-project" + (large ? " large" : "")}>
      <button className="primary add-btn" onClick={() => void pick()}>
        + Add project
      </button>
      <button className="ghost small link" onClick={() => setPasting(true)}>
        or paste a path
      </button>
    </div>
  );
}

function homeDir(): string {
  const m = /^\/Users\/[^/]+/.exec(document.location.href);
  return m ? m[0] : "";
}
