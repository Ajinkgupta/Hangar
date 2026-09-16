import { useEffect, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "../store";
import { deriveStatus, projectPort } from "../lib/status";
import type { Project } from "../lib/types";
import { AddProjectButton } from "./AddProject";

type Menu = { id: string; x: number; y: number };

export function Sidebar() {
  const projects = useStore((s) => s.config.projects);
  const activeId = useStore((s) => s.config.activeProjectId);
  const reorder = useStore((s) => s.reorderProjects);
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
      <div className="sidebar-title"><img src="/logo.svg" alt="" className="logo" /> Hangar</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <ul className="project-list">
            {projects.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                active={p.id === activeId}
                renaming={renaming === p.id}
                onRenamed={() => setRenaming(null)}
                onContextMenu={(x, y) => setMenu({ id: p.id, x, y })}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="sidebar-footer">
        <AddProjectButton />
        <DaemonIndicator />
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
  active,
  renaming,
  onRenamed,
  onContextMenu,
}: {
  project: Project;
  active: boolean;
  renaming: boolean;
  onRenamed: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const setActive = useStore((s) => s.setActive);
  const rename = useStore((s) => s.renameProject);
  const status = useStore((s) => deriveStatus(project.id, s.sessions, s.monitor));
  const port = useStore((s) => projectPort(project.id, s.monitor));
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name, renaming]);

  const commit = () => {
    const n = name.trim();
    if (n) rename(project.id, n);
    onRenamed();
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className={"project-item" + (active ? " active" : "")}
      onClick={() => setActive(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      {...attributes}
      {...listeners}
    >
      <span className={"dot " + status} title={status} />
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
        <span className="name" title={project.path}>{project.name}</span>
      )}
      {port !== null && <span className="port-badge">:{port}</span>}
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
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <button onClick={onRename}>Rename</button>
      <button onClick={() => void stop(menu.id).then(() => window.dispatchEvent(new Event("click")))}>Stop sessions</button>
      <button className="danger" onClick={() => void remove(menu.id).then(() => window.dispatchEvent(new Event("click")))}>
        Remove from Hangar
      </button>
    </div>
  );
}
