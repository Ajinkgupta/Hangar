import { useEffect, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { deriveStatus, projectPort } from "../lib/status";
import type { Project } from "../lib/types";
import { AddProjectButton } from "./AddProject";
import { openInEditor, openUrl } from "../lib/ipc";
import { SSH_PROJECT_ID, type Connection } from "../lib/types";

type Menu = { id: string; x: number; y: number };

export function Sidebar() {
  const projects = useStore(useShallow((s) => s.config.projects.filter((p) => p.kind !== "ssh")));
  const activeId = useStore((s) => s.config.activeProjectId);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const reorder = useStore((s) => s.reorderProjects);
  const waiting = useStore((s) => Object.keys(s.attention).length);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = projects.map((p) => p.id);
    reorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <img src="/logo.svg" alt="" className="logo" /> Hangar
      </div>
      <button className={"overview-item" + (view === "overview" ? " active" : "")} onClick={() => setView("overview")} title="All projects at a glance (⌘0)">
        <span className="grid-icon">▦</span> Overview
        {waiting > 0 && <span className="waiting-badge">{waiting} waiting</span>}
      </button>
      <button className="sidebar-search" onClick={() => useStore.getState().setPaletteOpen(true)}>
        <span>Search workspace…</span><kbd>⌘P</kbd>
      </button>
      <div className="sidebar-section">Projects</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <ul className="project-list">
            {projects.map((p, i) => (
              <ProjectItem
                key={p.id}
                project={p}
                index={i}
                active={view === "project" && p.id === activeId}
                renaming={renaming === p.id}
                onRenamed={() => setRenaming(null)}
                onContextMenu={(x, y) => setMenu({ id: p.id, x, y })}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <ConnectionsSection />
      <div className="sidebar-footer">
        <AddProjectButton />
        <div className="footer-row">
          <DaemonIndicator />
          <button className="ghost small" title="Settings (⌘,)" onClick={() => useStore.getState().setSettingsOpen(true)}>⚙</button>
        </div>
      </div>
      {menu && (
        <ContextMenu
          menu={menu}
          onRename={() => {
            setRenaming(menu.id);
            setMenu(null);
          }}
        />
      )}
    </aside>
  );
}

function ProjectItem({
  project,
  index,
  active,
  renaming,
  onRenamed,
  onContextMenu,
}: {
  project: Project;
  index: number;
  active: boolean;
  renaming: boolean;
  onRenamed: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const setActive = useStore((s) => s.setActive);
  const rename = useStore((s) => s.renameProject);
  const status = useStore((s) => deriveStatus(project.id, s.sessions, s.monitor, s.attention));
  const port = useStore((s) => projectPort(project.id, s.monitor));
  const agent = useStore((s) => {
    const a = Object.entries(s.monitor.agents).find(([sid]) => sid.startsWith(project.id + ":"));
    return a ? a[1] : null;
  });
  const summary = useStore((s) => s.gitSummary[project.path]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name, renaming]);

  const commit = () => {
    const n = name.trim();
    if (n) rename(project.id, n);
    onRenamed();
  };

  const title = `${project.path}${status === "attention" ? "\nneeds your attention" : ""}\n⌘${index + 1}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className={"project-item" + (active ? " active" : "") + (status === "attention" ? " attention" : "")}
      onClick={() => setActive(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={title}
      {...attributes}
      {...listeners}
    >
      <span className={"dot " + status} />
      <div className="project-item-body">
        {renaming ? (
          <input
            className="rename"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") onRenamed();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="name">{project.name}</span>
        )}
        <span className="project-meta">
          {status === "attention" ? (
            <span className="meta attention">needs you</span>
          ) : agent ? (
            <span className="meta agent">{agent}</span>
          ) : null}
          {summary?.is_repo && summary.branch && <span className="meta branch">⎇ {summary.branch}</span>}
          {summary?.is_repo && summary.files > 0 && (
            <span className="meta changes" title={`${summary.files} changed files on ${summary.branch}`}>
              <span className="add">+{summary.additions}</span> <span className="del">−{summary.deletions}</span>
            </span>
          )}
        </span>
      </div>
      {port !== null && (
        <span
          className="port-badge"
          title={`open http://localhost:${port}`}
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(`http://localhost:${port}`);
          }}
        >
          :{port}
        </span>
      )}
    </li>
  );
}

function ConnectionsSection() {
  const connections = useStore((s) => s.config.connections);
  const active = useStore((s) => s.view === "project" && s.config.activeProjectId === SSH_PROJECT_ID);
  const sshTerminals = useStore((s) => s.config.projects.find((p) => p.id === SSH_PROJECT_ID)?.terminals.length ?? 0);
  const run = useStore((s) => s.runConnection);
  const setActive = useStore((s) => s.setActive);
  const setEditor = useStore((s) => s.setConnectionEditor);
  const [menu, setMenu] = useState<{ c: Connection; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);
  return (
    <div className="connections">
      <div className="sidebar-section conn-head" onClick={() => setActive(SSH_PROJECT_ID)} title="Open the SSH terminals">
        <span className={active ? "on" : ""}>SSH & bastions</span>
        {sshTerminals > 0 && <span className="meta">{sshTerminals} open</span>}
        <button
          className="ghost small"
          title="Add a connection"
          onClick={(e) => {
            e.stopPropagation();
            setEditor("new");
          }}
        >
          +
        </button>
      </div>
      <ul className="conn-list">
        {connections.length === 0 && <li className="hint">No connections yet. Click + to save an ssh or bastion command.</li>}
        {connections.map((c) => (
          <ConnectionItem key={c.id} c={c} onRun={() => void run(c.id)} onMenu={(x, y) => setMenu({ c, x, y })} />
        ))}
      </ul>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => void run(menu.c.id).then(() => setMenu(null))}>Connect</button>
          <button
            onClick={() => {
              setEditor(menu.c);
              setMenu(null);
            }}
          >
            Edit…
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectionItem({ c, onRun, onMenu }: { c: Connection; onRun: () => void; onMenu: (x: number, y: number) => void }) {
  const state = useStore((s) => {
    const tid = s.config.connectionRuns[c.id];
    if (!tid) return "none";
    const sid = `${SSH_PROJECT_ID}:${tid}`;
    if (s.sessions[sid]?.alive === false) return "dead";
    if ((s.monitor.activity[sid] ?? 0) > 0 || s.connecting[sid] === "running") return "connected";
    return "idle";
  });
  const label = state === "connected" ? "connected - click to show" : state === "idle" ? "disconnected - click to reconnect in its tab" : "click to connect";
  return (
    <li
      className={"conn-item " + state}
      title={c.command + " · " + label + " · right-click to edit"}
      onClick={onRun}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className={"dot " + (state === "connected" ? "running" : state === "dead" ? "error" : "")} />
      <span className="name">{c.name}</span>
      {state === "connected" && <span className="meta live">live</span>}
      {c.steps.some((s) => s.secretRef) && <span className="meta" title="has a saved password">🔑</span>}
    </li>
  );
}

function DaemonIndicator() {
  const connected = useStore((s) => s.daemonConnected);
  const count = useStore((s) => Object.values(s.sessions).filter((x) => x.alive).length);
  return (
    <div className="daemon-indicator" title="Background session daemon: keeps terminals alive when Hangar is closed">
      <span className={"dot " + (connected ? "running" : "error")} />
      {connected ? `daemon · ${count} terminal${count === 1 ? "" : "s"} alive` : "daemon offline"}
    </div>
  );
}

function ContextMenu({ menu, onRename }: { menu: Menu; onRename: () => void }) {
  const stop = useStore((s) => s.stopSessions);
  const remove = useStore((s) => s.removeProject);
  const setWorktreeFor = useStore((s) => s.setWorktreeFor);
  const editors = useStore((s) => s.editors);
  const project = useStore((s) => s.config.projects.find((p) => p.id === menu.id));
  const isRepo = useStore((s) => (project ? s.gitSummary[project.path]?.is_repo : false));
  const done = () => window.dispatchEvent(new Event("click"));
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {editors[0] && project && (
        <button
          onClick={() => {
            void openInEditor(editors[0], project.path);
            done();
          }}
        >
          Open in {editors[0]}
        </button>
      )}
      <button onClick={onRename}>Rename</button>
      {isRepo && (
        <button
          onClick={() => {
            setWorktreeFor(menu.id);
            done();
          }}
        >
          New worktree…
        </button>
      )}
      <button onClick={() => void stop(menu.id).then(done)}>Stop all terminals</button>
      <button
        className={confirmRemove ? "danger solid" : "danger"}
        onClick={() => {
          if (confirmRemove) void remove(menu.id).then(done);
          else setConfirmRemove(true);
        }}
      >
        {confirmRemove ? "Really remove? (terminals end)" : "Remove from Hangar"}
      </button>
    </div>
  );
}
