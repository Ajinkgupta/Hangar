import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { browser, on } from "../lib/ipc";
import { projectPort } from "../lib/status";
import type { Project } from "../lib/types";

export function BrowserPane({ project }: { project: Project }) {
  const updateLayout = useStore((s) => s.updateLayout);
  const port = useStore((s) => projectPort(project.id, s.monitor));
  const url = project.layout.browserUrl;
  const [input, setInput] = useState(url ?? "");
  const [loading, setLoading] = useState(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const shownUrl = useRef<string | null>(null);

  useEffect(() => setInput(url ?? ""), [url]);

  const bounds = () => {
    const r = placeholderRef.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  };

  // Show / navigate / position the native webview.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el || !url) return;
    const b = bounds();
    if (b) {
      browser.show(project.id, url, b).catch((e) => useStore.getState().setError(String(e)));
      shownUrl.current = url;
    }
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const nb = bounds();
        if (nb) browser.setBounds(project.id, nb).catch(() => {});
      });
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      cancelAnimationFrame(raf);
      browser.hide(project.id).catch(() => {});
    };
  }, [project.id, url]);

  // Track navigations (redirects, in-page links) into the address bar.
  useEffect(() => {
    const un = on.browserNavigated((p) => {
      if (p.project_id !== project.id) return;
      setLoading(!p.finished);
      if (p.finished) {
        setInput(p.url);
        if (p.url !== useStore.getState().config.projects.find((x) => x.id === project.id)?.layout.browserUrl) {
          updateLayout(project.id, { browserUrl: p.url });
        }
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [project.id, updateLayout]);

  const go = (target: string) => {
    let t = target.trim();
    if (!t) return;
    if (/^\d+$/.test(t)) t = `http://localhost:${t}`;
    else if (!/^[a-z]+:\/\//i.test(t)) t = `http://${t}`;
    updateLayout(project.id, { browserUrl: t });
    if (shownUrl.current === t) browser.navigate(project.id, t).catch(() => {});
  };

  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <button onClick={() => browser.back(project.id)} title="Back">‹</button>
        <button onClick={() => browser.forward(project.id)} title="Forward">›</button>
        <button onClick={() => browser.reload(project.id)} title="Reload" className={loading ? "spinning" : ""}>↻</button>
        <input
          className="address"
          value={input}
          placeholder={port !== null ? `http://localhost:${port}` : "http://localhost:3000"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(input);
          }}
          spellCheck={false}
        />
        {port !== null && url !== `http://localhost:${port}` && (
          <button className="ghost" onClick={() => go(`http://localhost:${port}`)} title="Use the port this project is listening on">
            use :{port}
          </button>
        )}
        <button className="ghost" onClick={() => updateLayout(project.id, { browserOpen: false })} title="Close preview">✕</button>
      </div>
      <div ref={placeholderRef} className="browser-placeholder">
        {!url && (
          <div className="browser-empty">
            {port !== null ? (
              <button className="primary" onClick={() => go(`http://localhost:${port}`)}>Open http://localhost:{port}</button>
            ) : (
              <p>No server detected for this project yet. Start one from the shell tab, or type a URL above.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
