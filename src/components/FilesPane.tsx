import { useCallback, useEffect, useMemo, useState } from "react";
import { fs, type FileContent, type FsEntry } from "../lib/ipc";
import type { Project } from "../lib/types";
import { useStore } from "../store";

type Node = FsEntry & { children?: Node[]; open?: boolean; loading?: boolean };

/** Read-only project file tree with an in-app viewer (no external editor involved). */
export function FilesPane({ project }: { project: Project }) {
  const setError = useStore((s) => s.setError);
  const [roots, setRoots] = useState<Node[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(
    async (dir: string): Promise<Node[]> => {
      try {
        return await fs.list(project.path, dir);
      } catch (e) {
        setError(String(e));
        return [];
      }
    },
    [project.path, setError],
  );

  useEffect(() => {
    void load("").then(setRoots);
  }, [load]);

  // Refresh open folders every 5s while this tab is on screen (agents create files).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        setRoots((prev) => {
          void refreshTree(prev, "", load).then((next) => {
            if (!stopped) setRoots(next);
          });
          return prev;
        });
      }
      timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  const toggle = async (node: Node) => {
    const update = (nodes: Node[]): Node[] =>
      nodes.map((n) => (n.path === node.path ? { ...n, open: !n.open, loading: !n.open && !n.children } : n.children ? { ...n, children: update(n.children) } : n));
    setRoots((r) => update(r));
    if (!node.open && !node.children) {
      const children = await load(node.path);
      const fill = (nodes: Node[]): Node[] => nodes.map((n) => (n.path === node.path ? { ...n, children, loading: false } : n.children ? { ...n, children: fill(n.children) } : n));
      setRoots((r) => fill(r));
    }
  };

  const openFile = async (node: Node) => {
    setSelected(node.path);
    try {
      setFile(await fs.read(project.path, node.path));
    } catch (e) {
      setError(String(e));
    }
  };

  // Re-read the open file when its tab is visible and something may have changed.
  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fs.read(project.path, selected)
        .then((f) => {
          if (!stopped) setFile((prev) => (prev && prev.content === f.content && prev.size === f.size ? prev : f));
        })
        .catch(() => {});
    }, 4000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [selected, project.path]);

  const rel = (p: string) => (p.startsWith(project.path) ? p.slice(project.path.length + 1) : p);
  const lines = useMemo(() => (file && !file.binary ? file.content.split("\n") : []), [file]);
  const needle = filter.trim().toLowerCase();

  return (
    <div className="files-pane">
      <div className="files-tree">
        <div className="files-head">
          <input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="ghost small" title="Reload" onClick={() => void load("").then(setRoots)}>↻</button>
        </div>
        <ul>
          {roots.map((n) => (
            <TreeNode key={n.path} node={n} depth={0} selected={selected} needle={needle} onToggle={toggle} onOpen={openFile} />
          ))}
          {roots.length === 0 && <li className="muted pad">Empty folder.</li>}
        </ul>
      </div>
      <div className="files-view">
        {file ? (
          <>
            <div className="diff-header">
              <span className="mono path">{rel(file.path)}</span>
              <span className="hint">{fmtSize(file.size)}{file.truncated ? " · showing first 2 MB" : ""}</span>
              <span className="spacer" />
              <button className={"ghost small" + (wrap ? " on" : "")} onClick={() => setWrap(!wrap)}>wrap</button>
              <button className="ghost small" onClick={() => void navigator.clipboard.writeText(file.path)} title="Copy full path">copy path</button>
              <button className="ghost small" onClick={() => void fs.reveal(file.path)} title="Show in Finder">finder</button>
            </div>
            {file.binary ? (
              <div className="muted pad">Binary file.</div>
            ) : (
              <div className="diff-scroll">
                <table className={"diff file" + (wrap ? " wrap" : "")}>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="line">
                        <td className="num">{i + 1}</td>
                        <td className="code">{l}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="muted pad">Select a file to view it.</div>
        )}
      </div>
    </div>
  );
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
