import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { terminals } from "../lib/terminals";
import { sessionId, type Project, type TerminalTab } from "../lib/types";

export function TerminalPane({ project, tab, visible }: { project: Project; tab: TerminalTab; visible: boolean }) {
  const id = sessionId(project.id, tab.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useStore((s) => s.sessions[id]);
  const restart = useStore((s) => s.restartSession);
  const daemonConnected = useStore((s) => s.daemonConnected);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.attach(id, host);
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

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        terminals.fit(id);
        terminals.focus(id);
      });
    }
  }, [visible, id]);

  const ended = session && !session.alive;
  return (
    <div className="terminal-pane">
      <div ref={hostRef} className="terminal-host" />
      {ended && (
        <div className="terminal-overlay">
          <div>
            Session ended{session.exitCode !== null ? ` (exit code ${session.exitCode})` : ""}.
          </div>
          <button className="primary" disabled={!daemonConnected} onClick={() => void restart(project.id, tab.id)}>
            Restart terminal
          </button>
        </div>
      )}
    </div>
  );
}
