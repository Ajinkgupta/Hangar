import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { CHANGES_TAB } from "../lib/types";

type Item = { key: string; label: string; hint: string; run: () => void };

/** ⌘P: jump to any project or terminal by name. */
export function CommandPalette() {
  const close = () => useStore.getState().setPaletteOpen(false);
  const projects = useStore(useShallow((s) => s.config.projects.filter((p) => p.kind !== "ssh")));
  const connections = useStore((s) => s.config.connections);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

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
      out.push({
        key: `${p.id}:changes`,
        label: `${p.name} › changes`,
        hint: "git diff",
        run: () => {
          s.setActive(p.id);
          s.updateLayout(p.id, { activeTab: CHANGES_TAB });
        },
      });
      out.push({ key: `${p.id}:new`, label: `${p.name} › new terminal`, hint: "⌘T", run: () => void s.addTerminal(p.id) });
    }
    for (const c of connections) {
      out.push({ key: `conn:${c.id}`, label: `ssh › ${c.name}`, hint: c.command, run: () => void s.runConnection(c.id) });
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    return out.filter((i) => fuzzy(i.label.toLowerCase(), needle) || i.hint.toLowerCase().includes(needle));
  }, [projects, connections, q]);

  useEffect(() => setCursor(0), [q]);

  const pick = (i: Item) => {
    i.run();
    close();
  };

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Jump to project or terminal…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") setCursor((c) => Math.min(items.length - 1, c + 1));
            if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
            if (e.key === "Enter" && items[cursor]) pick(items[cursor]);
          }}
        />
        <ul>
          {items.slice(0, 12).map((i, idx) => (
            <li key={i.key} className={idx === cursor ? "selected" : ""} onMouseEnter={() => setCursor(idx)} onClick={() => pick(i)}>
              <span className="label">{i.label}</span>
              <span className="hint">{i.hint}</span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

function fuzzy(hay: string, needle: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}
