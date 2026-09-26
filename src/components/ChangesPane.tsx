import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { git, openInEditor, type FileStatus, type GitStatus } from "../lib/ipc";
import { parseUnifiedDiff } from "../lib/diff";
import type { Project } from "../lib/types";
import { DiffView } from "./DiffView";
import { pollWhileVisible } from "../lib/polling";

const STATUS_LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", "?": "untracked" };

export function ChangesPane({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const editors = useStore((s) => s.editors);
  const view = project.layout.diffView;
  const openFile = (f: FileStatus) => {
    if (editors[0] && f.status !== "D") void openInEditor(editors[0], `${project.path}/${f.path}`);
  };
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Poll status every 5s while mounted (git status on a big repo is not free).
  useEffect(() => {
    const stop = pollWhileVisible(async () => {
      const s = await git.status(project.path).catch((e) => ({ is_repo: true, files: [], error: String(e) }) as GitStatus);
      setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
      setTick((n) => n + 1);
    }, () => 5000, document, (e) => setStatus({ is_repo: true, files: [], error: String(e) }));
    return stop;
  }, [project.path]);

  const files = status?.files ?? [];
  const current = files.find((f) => f.path === selected) ?? null;
  const currentKey = current ? `${current.path}|${current.status}|${current.staged}` : null;

  useEffect(() => {
    if (!selected && files.length) setSelected(files[0].path);
    if (selected && !files.some((f) => f.path === selected)) setSelected(files[0]?.path ?? null);
  }, [files, selected]);

  // (Re)fetch the selected file's diff whenever its status entry changes.
  useEffect(() => {
    if (!current || !currentKey) return;
    let cancelled = false;
    setLoading(current.path);
    git
      .diff(project.path, current.path, current.status === "?", current.old_path)
      .then((d) => {
        if (!cancelled) {
          setDiffs((prev) => ({ ...prev, [current.path]: d }));
          setDiffErrors((prev) => ({ ...prev, [current.path]: undefined }));
        }
      })
      .catch((e) => {
        if (!cancelled) setDiffErrors((prev) => ({ ...prev, [current.path]: String(e) }));
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path, currentKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => (current && diffs[current.path] !== undefined ? parseUnifiedDiff(diffs[current.path]) : null), [current, diffs]);

  if (status?.error) return <div className="changes-empty error-text">Could not load changes: {status.error}</div>;
  if (status && !status.is_repo) return <div className="changes-empty">Not a git repository.</div>;

  return (
    <div className="changes-pane">
      <div className="changes-files">
        <div className="changes-files-header">
          <span>{files.length} changed file{files.length === 1 ? "" : "s"}</span>
          {status?.error && <span className="error-text" title={status.error}>git error</span>}
        </div>
        <ul>
          {files.map((f) => (
            <FileRow key={f.path} file={f} selected={f.path === selected} onClick={() => setSelected(f.path)} onOpen={() => openFile(f)} />
          ))}
          {status && files.length === 0 && <li className="muted">Working tree clean.</li>}
        </ul>
      </div>
      <div className="changes-diff">
        {current && (
          <div className="diff-header">
            <span className="mono path">
              {current.old_path ? `${current.old_path} → ` : ""}
              {current.path}
            </span>
            {parsed && !parsed.binary && (
              <span className="counts">
                <span className="add">+{parsed.additions}</span> <span className="del">−{parsed.deletions}</span>
              </span>
            )}
            <span className="spacer" />
            {editors[0] && current.status !== "D" && (
              <button className="ghost small" onClick={() => openFile(current)} title="Open this file in the editor">
                open in {editors[0].replace("Visual Studio Code", "VS Code")}
              </button>
            )}
            <div className="seg">
              <button className={view === "unified" ? "on" : ""} onClick={() => updateLayout(project.id, { diffView: "unified" })}>Unified</button>
              <button className={view === "split" ? "on" : ""} onClick={() => updateLayout(project.id, { diffView: "split" })}>Split</button>
            </div>
          </div>
        )}
        {current && diffErrors[current.path] && <div className="error-text pad">Could not load diff: {diffErrors[current.path]}</div>}
        {current && !diffErrors[current.path] && parsed && <DiffView diff={parsed} mode={view} />}
        {current && !diffErrors[current.path] && !parsed && loading && <div className="muted pad">Loading diff…</div>}
        {!current && <div className="muted pad">Select a file to see its diff.</div>}
      </div>
    </div>
  );
}

function FileRow({ file, selected, onClick, onOpen }: { file: FileStatus; selected: boolean; onClick: () => void; onOpen: () => void }) {
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const base = file.path.slice(dir.length);
  return (
    <li
      className={"file-row" + (selected ? " selected" : "")}
      onClick={onClick}
      onDoubleClick={onOpen}
      title={`${STATUS_LABEL[file.status] ?? file.status}${file.staged ? " (staged)" : ""} · double-click to open in editor`}
    >
      <span className={"status-letter s-" + (file.status === "?" ? "U" : file.status)}>{file.status === "?" ? "U" : file.status}</span>
      <span className="file-name">
        <span className="dir">{dir}</span>
        {base}
      </span>
    </li>
  );
}
