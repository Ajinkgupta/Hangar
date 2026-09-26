import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { fs, type FileContent, type FsEntry } from "../lib/ipc";
import { fileTextForSave, setFileDraft, useFileDrafts } from "../lib/fileDrafts";
import type { Project } from "../lib/types";
import { useStore } from "../store";
import { pollWhileVisible } from "../lib/polling";

type Node = FsEntry & { children?: Node[]; open?: boolean; loading?: boolean };

export function FilesPane({ project }: { project: Project }) {
  const setError = useStore((s) => s.setError);
  const [roots, setRoots] = useState<Node[]>([]);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const treeGeneration = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const visibleFile = useRef<string | null>(null);
  visibleFile.current = file?.path ?? null;
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [newPath, setNewPath] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const readGeneration = useRef(0);
  const drafts = useFileDrafts((s) => s.drafts);
  const projectDrafts = Object.keys(drafts).filter((p) => p.startsWith(project.path.replace(/\/$/, "") + "/"));

  const load = useCallback((dir: string): Promise<Node[]> => fs.list(project.path, dir), [project.path]);
  const refresh = useCallback(async () => {
    const generation = ++treeGeneration.current;
    try {
      const next = await refreshTree(rootsRef.current, "", load);
      if (generation === treeGeneration.current) setRoots(next);
    } catch (e) { setError(String(e)); }
  }, [load, setError]);

  useEffect(() => {
    const stop = pollWhileVisible(refresh, () => 5000, document, (e) => setError(String(e)));
    return () => { stop(); ++treeGeneration.current; };
  }, [refresh]);

  const toggle = async (node: Node) => {
    ++treeGeneration.current;
    const update = (nodes: Node[]): Node[] => nodes.map((n) => n.path === node.path
      ? { ...n, open: !n.open, loading: !n.open && !n.children }
      : n.children ? { ...n, children: update(n.children) } : n);
    setRoots(update);
    if (!node.open && !node.children) {
      try {
        const children = await load(node.path);
        const fill = (nodes: Node[]): Node[] => nodes.map((n) => n.path === node.path
          ? { ...n, children, loading: false }
          : n.children ? { ...n, children: fill(n.children) } : n);
        ++treeGeneration.current;
        setRoots(fill);
      } catch (e) { setError(String(e)); void refresh(); }
    }
  };

  useEffect(() => {
    setFile(null);
    if (!selected) return;
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      const generation = ++readGeneration.current;
      reading = true;
      try {
        const next = await fs.read(project.path, selected);
        if (!stopped && generation === readGeneration.current) setFile(next);
      } catch (e) { if (!stopped) setError(String(e)); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void read(); }, 4000);
    return () => { stopped = true; ++readGeneration.current; clearInterval(timer); };
  }, [selected, project.path, setError]);

  const create = async () => {
    if (!creating || !newPath.trim() || createBusy) return;
    setCreateBusy(true);
    try {
      const path = await fs.create(project.path, newPath.trim(), creating === "folder");
      if (creating === "file") setSelected(path);
      setCreating(null); setNewPath("");
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setCreateBusy(false); }
  };
  const rel = (p: string) => p.startsWith(project.path + "/") ? p.slice(project.path.length + 1) : p;

  return (
    <div className="files-pane">
      <div className="files-tree">
        <div className="files-head">
          <input aria-label="Filter files" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="ghost small" title="Reload" onClick={() => void refresh()}>↻</button>
        </div>
        <div className="files-head">
          <button className="ghost small" onClick={() => { setCreating("file"); setNewPath(""); }}>+ file</button>
          <button className="ghost small" onClick={() => { setCreating("folder"); setNewPath(""); }}>+ folder</button>
        </div>
        {creating && <form className="files-create" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input autoFocus aria-label="New path" placeholder={creating === "file" ? "src/new-file.ts" : "folder-name"} value={newPath} onChange={(e) => setNewPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setCreating(null); }} />
          <span className="hint">Path relative to project; parent folder must exist.</span>
          <div><button className="primary small" disabled={createBusy || !newPath.trim()}>Create {creating}</button><button type="button" className="ghost small" onClick={() => setCreating(null)}>Cancel</button></div>
        </form>}
        {projectDrafts.length > 0 && <div className="file-drafts">
          <span className="hint">Unsaved drafts</span>
          {projectDrafts.map((path) => <button key={path} className="ghost small" onClick={() => setSelected(path)} title={path}>● {rel(path)}</button>)}
        </div>}
        <ul>
          {roots.map((node) => <TreeNode key={node.path} node={node} depth={0} selected={selected} needle={filter.trim().toLowerCase()} onToggle={toggle} onOpen={(n) => setSelected(n.path)} />)}
          {roots.length === 0 && <li className="muted pad">Empty folder.</li>}
          {roots.length > 0 && filter.trim() && !hasTreeMatch(roots, filter.trim().toLowerCase()) && <li className="muted pad">No files match “{filter.trim()}”.</li>}
        </ul>
      </div>
      <div className="files-view">
        {file ? <FileEditor key={file.path} file={file} root={project.path} label={rel(file.path)} onSaved={(next) => {
          if (visibleFile.current === next.path) { ++readGeneration.current; setFile(next); }
        }} /> : <div className="muted pad">{selected ? "Opening file…" : "Select a file to edit it."}</div>}
      </div>
    </div>
  );
}

function FileEditor({ file, root, label, onSaved }: { file: FileContent; root: string; label: string; onSaved: (file: FileContent) => void }) {
  const draft = useFileDrafts((s) => s.drafts[file.path]);
  const setError = useStore((s) => s.setError);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [wrap, setWrap] = useState(false);
  const [message, setMessage] = useState("");
  const text = draft?.text ?? file.content;
  const editable = !file.binary && !file.truncated;
  const conflict = !!draft && draft.base !== file.content;
  const change = (text: string) => {
    const base = draft?.base ?? file.content;
    setFileDraft(file.path, fileTextForSave(base, text) === base ? null : { base, text });
    setMessage("");
  };
  const save = async () => {
    if (!draft || !editable || savingRef.current) return;
    savingRef.current = true; setSaving(true); setMessage("");
    const content = fileTextForSave(draft.base, draft.text);
    try {
      await fs.write(root, file.path, draft.base, content);
      onSaved({ ...file, content, size: new TextEncoder().encode(content).length });
      // A user may have switched tabs and edited this same draft during the save.
      const current = useFileDrafts.getState().drafts[file.path];
      if (current?.text === draft.text && current.base === draft.base) setFileDraft(file.path, null);
      else if (current) setFileDraft(file.path, { ...current, base: content });
      setMessage("Saved");
    } catch (e) { setMessage(String(e)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const reload = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      if (draft && !await ask("Discard your unsaved draft and load the version on disk?", { title: "Reload file", kind: "warning" })) return;
      const next = await fs.read(root, file.path);
      setFileDraft(file.path, null); onSaved(next); setMessage("");
    } catch (e) { setMessage(String(e)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <div className="file-editor" onKeyDown={(e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
  }}>
    <div className="diff-header">
      <span className="mono path">{label}{draft ? " ●" : ""}</span>
      <span className="hint">{fmtSize(file.size)}{file.truncated ? " · first 2 MB · read only" : ""}</span>
      <span className="spacer" />
      <button className="primary small" disabled={!draft || !editable || saving || conflict} onClick={() => void save()}>{saving ? "Saving…" : "Save ⌘S"}</button>
      <button className="ghost small" disabled={saving} onClick={() => void reload()}>Reload</button>
      <button className={"ghost small" + (wrap ? " on" : "")} onClick={() => setWrap(!wrap)}>wrap</button>
      <button className="ghost small" onClick={() => void navigator.clipboard.writeText(file.path).catch((e) => setError(String(e)))}>copy path</button>
    </div>
    {conflict && <div className="file-notice" role="alert">Changed on disk. Your draft is preserved. Copy it before reloading if you want to merge your edits. <button className="ghost small" onClick={() => void navigator.clipboard.writeText(text).catch((e) => setError(String(e)))}>Copy draft</button></div>}
    {message && <div className="file-notice" role="status">{message}</div>}
    {file.binary ? <div className="muted pad">Binary or non-UTF-8 file. Editing is unavailable.</div> : <textarea
      className="file-code" aria-label={`Edit ${label}`} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap={wrap ? "soft" : "off"}
      readOnly={!editable || saving} value={text} onChange={(e) => change(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Tab" && editable && !saving) {
          e.preventDefault();
          const input = e.currentTarget;
          const start = input.selectionStart; const end = input.selectionEnd;
          change(text.slice(0, start) + "  " + text.slice(end));
          requestAnimationFrame(() => input.setSelectionRange(start + 2, start + 2));
        }
      }}
    />}
    <div className="file-status hint">{draft ? "Unsaved draft · kept when switching tabs" : "Saved on disk"} · {text.split("\n").length} lines{editable ? " · UTF-8" : " · read only"}</div>
  </div>;
}

function TreeNode({
  node,
  depth,
  selected,
  needle,
  onToggle,
  onOpen,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  needle: string;
  onToggle: (n: Node) => void;
  onOpen: (n: Node) => void;
}) {
  if (needle && !node.is_dir && !node.name.toLowerCase().includes(needle)) return null;
  return (
    <>
      <li
        className={"tree-row" + (selected === node.path ? " selected" : "") + (node.ignored ? " ignored" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (node.is_dir ? onToggle(node) : onOpen(node))}
        title={node.path}
      >
        <span className="tree-icon">{node.is_dir ? (node.open ? "▾" : "▸") : "·"}</span>
        <span className="tree-name">{node.name}</span>
        {node.loading && <span className="hint">…</span>}
      </li>
      {node.is_dir && node.open && node.children?.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} needle={needle} onToggle={onToggle} onOpen={onOpen} />
      ))}
    </>
  );
}

async function refreshTree(nodes: Node[], _dir: string, load: (dir: string) => Promise<Node[]>): Promise<Node[]> {
  // Re-list the root and every open folder, preserving open state.
  const relist = async (list: Node[], dir: string): Promise<Node[]> => {
    const fresh = await load(dir);
    const byPath = new Map(list.map((n) => [n.path, n]));
    const out: Node[] = [];
    for (const f of fresh) {
      const old = byPath.get(f.path);
      if (old?.is_dir && old.open && old.children) out.push({ ...f, open: true, children: await relist(old.children, f.path) });
      else out.push(old ? { ...f, open: old.open, children: old.children } : f);
    }
    return out;
  };
  return relist(nodes, "");
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function hasTreeMatch(nodes: Node[], needle: string): boolean {
  return nodes.some((node) => node.name.toLowerCase().includes(needle) || (node.children ? hasTreeMatch(node.children, needle) : false));
}
