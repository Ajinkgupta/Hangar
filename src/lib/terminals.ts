/**
 * Registry of xterm.js instances, one per session, living outside React so that
 * switching projects/tabs never re-creates a terminal or loses its screen state.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { b64decode, b64encode, openUrl, pty } from "./ipc";

const ENDED_MARKER = "\r\n\x1b[2m[hangar: previous session ended — new session started]\x1b[0m\r\n";

type Entry = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webgl: WebglAddon | null;
  el: HTMLDivElement;
  opened: boolean;
  ready: boolean; // scrollback loaded; live output may be written directly
  queue: string[]; // base64 chunks received before ready
  lastSize: { cols: number; rows: number } | null;
};

const entries = new Map<string, Entry>();

/** Set by the app: called when the user types into a terminal. */
export const terminalHooks: { onInput: (id: string) => void } = { onInput: () => {} };

function makeTerminal(): Terminal {
  return new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    scrollback: 8000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: {
      background: "#0f1115",
      foreground: "#d6dbe5",
      cursor: "#5eead4",
      selectionBackground: "rgba(94,234,212,0.25)",
      black: "#1b1e26",
      brightBlack: "#5c6370",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#d6dbe5",
    },
  });
}

async function loadScrollback(id: string, e: Entry) {
  try {
    const data = await pty.scrollback(id);
    if (data) e.term.write(b64decode(data));
  } catch {
    /* daemon may be down; live output will still arrive */
  }
  e.ready = true;
  for (const chunk of e.queue) e.term.write(b64decode(chunk));
  e.queue = [];
  // Nudge: a size change makes full-screen programs (claude, vim, htop) repaint from
  // scratch, so a replayed tail never leaves a garbled screen behind.
  const { cols, rows } = e.term;
  if (cols > 2 && rows > 1) {
    pty.resize(id, cols - 1, rows).catch(() => {});
    setTimeout(() => pty.resize(id, cols, rows).catch(() => {}), 60);
  }
}

function attachWebgl(e: Entry) {
  if (e.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (e.webgl === webgl) e.webgl = null;
    });
    e.term.loadAddon(webgl);
    e.webgl = webgl;
  } catch {
    e.webgl = null; // DOM renderer
  }
}

export const terminals = {
  get(id: string): Entry | undefined {
    return entries.get(id);
  },

  /** Creates the entry on first use and puts its element into `host` (no rendering yet). */
  mount(id: string, host: HTMLElement): Entry {
    let e = entries.get(id);
    if (!e) {
      const term = makeTerminal();
      const fit = new FitAddon();
      const search = new SearchAddon();
      const el = document.createElement("div");
      el.className = "xterm-host";
      e = { term, fit, search, webgl: null, el, opened: false, ready: false, queue: [], lastSize: null };
      entries.set(id, e);
      term.onData((data) => {
        terminalHooks.onInput(id);
        pty.write(id, b64encode(data)).catch(() => {});
      });
      term.onBinary((data) => {
        pty.write(id, btoa(data)).catch(() => {});
      });
      // Cmd+C copies the selection (like VS Code); everything else goes to the shell.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type === "keydown" && ev.metaKey && ev.key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (ev.type === "keydown" && ev.metaKey && ev.key === "k") {
          term.clear();
          return false;
        }
        return true;
      });
    }
    if (e.el.parentElement !== host) host.appendChild(e.el);
    return e;
  },

  /**
   * Renders the terminal. Must only be called while the element is visible:
   * xterm measures the font and sizes its canvas at open time, so opening inside a
   * display:none tab yields a blank terminal that never paints.
   */
  open(id: string) {
    const e = entries.get(id);
    if (!e || e.opened || !e.el.isConnected || e.el.offsetParent === null) return;
    e.opened = true;
    e.term.loadAddon(e.fit);
    e.term.loadAddon(new WebLinksAddon((_ev, url) => void openUrl(url)));
    e.term.loadAddon(e.search);
    const unicode = new Unicode11Addon();
    e.term.loadAddon(unicode);
    e.term.unicode.activeVersion = "11";
    e.term.open(e.el);
    attachWebgl(e);
    void loadScrollback(id, e);
  },

  /** Hidden terminals drop their GPU renderer; it comes back when shown. */
  setVisible(id: string, visible: boolean) {
    const e = entries.get(id);
    if (!e || !e.opened) return;
    if (visible) attachWebgl(e);
    else if (e.webgl) {
      e.webgl.dispose();
      e.webgl = null;
    }
  },

  detach(id: string) {
    const e = entries.get(id);
    if (e?.el.parentElement) e.el.parentElement.removeChild(e.el);
  },

  /** Fits to the host and tells the PTY the new size if it changed. */
  fit(id: string) {
    const e = entries.get(id);
    if (!e || !e.opened || !e.el.isConnected || e.el.offsetParent === null) return;
    try {
      e.fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = e.term;
    if (cols < 2 || rows < 1) return;
    if (e.lastSize && e.lastSize.cols === cols && e.lastSize.rows === rows) return;
    e.lastSize = { cols, rows };
    pty.resize(id, cols, rows).catch(() => {});
  },

  focus(id: string) {
    entries.get(id)?.term.focus();
  },

  findNext(id: string, query: string) {
    return entries.get(id)?.search.findNext(query, { incremental: false, caseSensitive: false }) ?? false;
  },

  findPrevious(id: string, query: string) {
    return entries.get(id)?.search.findPrevious(query, { caseSensitive: false }) ?? false;
  },

  clearSearch(id: string) {
    entries.get(id)?.search.clearDecorations();
  },

  handleOutput(id: string, data: string) {
    const e = entries.get(id);
    if (!e) return; // not attached yet; scrollback will cover it on first attach
    if (e.ready) e.term.write(b64decode(data));
    else e.queue.push(data);
  },

  markRestarted(id: string) {
    entries.get(id)?.term.write(ENDED_MARKER);
    terminals.resync(id);
  },

  /** A (re)created PTY starts at a default size; push the terminal's real size to it. */
  resync(id: string) {
    const e = entries.get(id);
    if (!e) return;
    e.lastSize = null;
    requestAnimationFrame(() => terminals.fit(id));
  },

  destroy(id: string) {
    const e = entries.get(id);
    if (!e) return;
    e.webgl?.dispose();
    e.term.dispose();
    e.el.remove();
    entries.delete(id);
  },
};
