import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { git, type FileStatus, type GitStatus } from "../lib/ipc";
import { parseUnifiedDiff } from "../lib/diff";
import type { Project } from "../lib/types";
import { DiffView } from "./DiffView";

const STATUS_LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", "?": "untracked" };

export function ChangesPane({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const view = project.layout.diffView;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  // Poll status every 5s while mounted (git status on a big repo is not free).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      const s = await git.status(project.path).catch((e) => ({ is_repo: true, files: [], error: String(e) }) as GitStatus);
      if (stopped) return;
      setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
      timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
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
        if (!cancelled) setDiffs((prev) => ({ ...prev, [current.path]: d }));
      })
      .catch((e) => {
        if (!cancelled) setDiffs((prev) => ({ ...prev, [current.path]: `\\ error: ${e}` }));
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path, currentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => (current && diffs[current.path] !== undefined ? parseUnifiedDiff(diffs[current.path]) : null), [current, diffs]);

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
            <FileRow key={f.path} file={f} selected={f.path === selected} onClick={() => setSelected(f.path)} />
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
            <div className="seg">
              <button className={view === "unified" ? "on" : ""} onClick={() => updateLayout(project.id, { diffView: "unified" })}>Unified</button>
              <button className={view === "split" ? "on" : ""} onClick={() => updateLayout(project.id, { diffView: "split" })}>Split</button>
            </div>
          </div>
        )}
        {current && parsed && <DiffView diff={parsed} mode={view} />}
        {current && !parsed && loading && <div className="muted pad">Loading diff…</div>}
        {!current && <div className="muted pad">Select a file to see its diff.</div>}
      </div>
    </div>
  );
}

function FileRow({ file, selected, onClick }: { file: FileStatus; selected: boolean; onClick: () => void }) {
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const base = file.path.slice(dir.length);
  return (
    <li className={"file-row" + (selected ? " selected" : "")} onClick={onClick} title={`${STATUS_LABEL[file.status] ?? file.status}${file.staged ? " (staged)" : ""}`}>
      <span className={"status-letter s-" + (file.status === "?" ? "U" : file.status)}>{file.status === "?" ? "U" : file.status}</span>
      <span className="file-name">
        <span className="dir">{dir}</span>
        {base}
      </span>
    </li>
  );
}
