import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { terminals } from "../lib/terminals";
import { sessionId, type Project, type TerminalTab } from "../lib/types";

export function TerminalPane({ project, tab, visible }: { project: Project; tab: TerminalTab; visible: boolean }) {
  const id = sessionId(project.id, tab.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useStore((s) => s.sessions[id]);
  const restart = useStore((s) => s.restartSession);
  const daemonConnected = useStore((s) => s.daemonConnected);
  const [find, setFind] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);

  // Cmd+F opens the find bar for the visible terminal.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFind((f) => f ?? "");
        requestAnimationFrame(() => findRef.current?.select());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.mount(id, host);
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => terminals.fit(id));
    };
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    refit();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      terminals.detach(id);
    };
  }, [id]);

  const clearAttention = useStore((s) => s.clearAttention);
  useEffect(() => {
    if (!visible) {
      terminals.setVisible(id, false);
      return;
    }
    if (document.hasFocus()) clearAttention(id);
    const onFocus = () => clearAttention(id);
    window.addEventListener("focus", onFocus);
    const raf = requestAnimationFrame(() => {
      terminals.open(id);
      terminals.setVisible(id, true);
      terminals.fit(id);
      terminals.focus(id);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("focus", onFocus);
    };
  }, [visible, id, clearAttention]);

  const ended = session && !session.alive;
  return (
    <div className="terminal-pane">
      <div ref={hostRef} className="terminal-host" />
      {find !== null && (
        <div className="find-bar">
          <input
            ref={findRef}
            autoFocus
            placeholder="Find"
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              terminals.findNext(id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? terminals.findPrevious : terminals.findNext)(id, find);
              if (e.key === "Escape") {
                terminals.clearSearch(id);
                setFind(null);
                terminals.focus(id);
              }
            }}
          />
          <button className="ghost small" onClick={() => terminals.findPrevious(id, find)} title="Previous (⇧↵)">↑</button>
          <button className="ghost small" onClick={() => terminals.findNext(id, find)} title="Next (↵)">↓</button>
          <button
            className="ghost small"
            onClick={() => {
              terminals.clearSearch(id);
              setFind(null);
              terminals.focus(id);
            }}
            title="Close (esc)"
          >
            ✕
          </button>
        </div>
      )}
      {ended && (
        <div className="terminal-overlay">
          <div>
            Session ended{session.exitCode !== null ? ` (exit code ${session.exitCode})` : ""}.
          </div>
          <button className="primary" onClick={() => void restart(project.id, tab.id)}>
            Restart terminal
          </button>
          {!daemonConnected && <span className="hint">waiting for the session daemon…</span>}
        </div>
      )}
    </div>
  );
}
