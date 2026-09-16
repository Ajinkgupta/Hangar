import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";

export function AddProjectButton({ large = false }: { large?: boolean }) {
  const addProject = useStore((s) => s.addProject);
  const [pasting, setPasting] = useState(false);
  const [path, setPath] = useState("");

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Add project folder" });
    if (typeof dir === "string" && dir) await addProject(dir);
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
        <button onClick={() => void submitPath()}>Add</button>
        <button className="ghost" onClick={() => setPasting(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className={"add-project" + (large ? " large" : "")}>
      <button className="primary" onClick={() => void pick()}>+ Add project</button>
      <button className="ghost" onClick={() => setPasting(true)} title="Paste a path instead">paste path</button>
    </div>
  );
}

function homeDir(): string {
  // Tauri's webview doesn't expose $HOME; the daemon resolves relative paths from its own cwd,
  // so expand ~ using the conventional macOS location of the current user.
  const m = /^\/Users\/[^/]+/.exec(document.location.href);
  return m ? m[0] : "";
}
