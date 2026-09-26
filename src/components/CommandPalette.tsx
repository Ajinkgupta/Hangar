import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { CHANGES_TAB, FILES_TAB, TASKS_TAB, sessionId } from "../lib/types";
import { terminals } from "../lib/terminals";

type Item = { key: string; label: string; hint: string; run: () => void };

/** ⌘P: jump to any project or terminal by name. */
export function CommandPalette() {
  const close = () => {
    useStore.getState().setPaletteOpen(false);
    const s = useStore.getState();
    const p = s.config.projects.find((x) => x.id === s.config.activeProjectId);
    if (p && s.view === "project") requestAnimationFrame(() => terminals.focus(sessionId(p.id, p.layout.activeTab)));
  };
  const projects = useStore(useShallow((s) => s.config.projects.filter((p) => p.kind !== "ssh")));
  const connections = useStore((s) => s.config.connections);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<Item[]>(() => {
    const s = useStore.getState();
    const out: Item[] = [{ key: "overview", label: "Overview", hint: "all projects", run: () => s.setView("overview") }];
    for (const p of projects) {
      out.push({ key: p.id, label: p.name, hint: p.path, run: () => s.setActive(p.id) });
      for (const t of p.terminals) {
        out.push({
          key: `${p.id}:${t.id}`,
          label: `${p.name} › ${t.name}`,
          hint: s.monitor.agents[`${p.id}:${t.id}`] ?? "terminal",
          run: () => {
            s.setActive(p.id);
            s.updateLayout(p.id, { activeTab: t.id });
          },
        });
      }
      for (const [tab, label, hint] of [[FILES_TAB, "Files", "browse and edit files"], [CHANGES_TAB, "Changes", "git diff"], [TASKS_TAB, "Tasks", "shared agent checklist"]]) {
        out.push({ key: `${p.id}:${tab}`, label: `${p.name} › ${label}`, hint, run: () => {
          s.setActive(p.id);
          s.updateLayout(p.id, { activeTab: tab });
        } });
      }
      out.push({ key: `${p.id}:new`, label: `${p.name} › new terminal`, hint: "⌘T", run: () => {
        s.setActive(p.id);
        void s.addTerminal(p.id);
      } });
    }
    for (const c of connections) {
      out.push({ key: `conn:${c.id}`, label: `ssh › ${c.name}`, hint: c.command, run: () => void s.runConnection(c.id) });
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    return out.filter((i) => fuzzy(i.label.toLowerCase(), needle) || i.hint.toLowerCase().includes(needle));
  }, [projects, connections, q]);

  useEffect(() => setCursor(0), [q]);
  const selected = Math.max(0, Math.min(cursor, items.length - 1));
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, q]);

  const pick = (i: Item) => {
    i.run();
    close();
  };

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Quick navigation" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Find projects, terminals, files, or tasks…"
          role="combobox" aria-label="Search Hangar" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list"
          aria-activedescendant={items.length ? `palette-result-${selected}` : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab") e.preventDefault();
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(Math.max(0, items.length - 1), selected + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(0, selected - 1)); }
            if (e.key === "Enter" && items[selected]) pick(items[selected]);
          }}
        />
        <ul ref={listRef} id="palette-results" role="listbox">
          {items.map((i, idx) => (
            <li key={i.key} id={`palette-result-${idx}`} role="option" aria-selected={idx === selected} className={idx === selected ? "selected" : ""} onMouseEnter={() => setCursor(idx)} onClick={() => pick(i)}>
              <span className="label">{i.label}</span>
              <span className="hint">{i.hint}</span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches. Try a project name or “tasks”.</li>}
        </ul>
        <div className="palette-footer"><span>{items.length} results</span><span><kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>esc</kbd> close</span></div>
      </div>
    </div>
  );
}

function fuzzy(hay: string, needle: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}
