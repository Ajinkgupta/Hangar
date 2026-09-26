import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  options = { cursorBlink: true };
  write = vi.fn(); reset = vi.fn(); dispose = vi.fn();
  onData = vi.fn(); onBinary = vi.fn(); attachCustomKeyEventHandler = vi.fn();
} }));
for (const [module, name] of [
  ["@xterm/addon-fit", "FitAddon"], ["@xterm/addon-search", "SearchAddon"],
  ["@xterm/addon-web-links", "WebLinksAddon"], ["@xterm/addon-webgl", "WebglAddon"],
  ["@xterm/addon-unicode11", "Unicode11Addon"],
]) {
  vi.doMock(module, () => ({ [name]: class {} }));
}
vi.mock("./ipc", () => ({
  pty: { scrollback: vi.fn(), resize: vi.fn().mockResolvedValue(undefined) },
  b64decode: (s: string) => s,
}));
const { terminals } = await import("./terminals");
const { pty } = await import("./ipc");

function mount(id: string) {
  vi.stubGlobal("document", { createElement: () => ({ remove: vi.fn() }) });
  return terminals.mount(id, { appendChild: vi.fn() } as unknown as HTMLElement);
}

afterEach(() => {
  for (const id of terminals.allIds()) terminals.destroy(id);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("terminal scrollback lifecycle", () => {
  it("releases GPU rendering and stops cursor animation when hidden", () => {
    const entry = mount("background");
    entry.opened = true;
    const dispose = vi.fn();
    entry.webgl = { dispose } as unknown as NonNullable<typeof entry.webgl>;
    terminals.setVisible("background", false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(entry.webgl).toBeNull();
    expect(entry.term.options.cursorBlink).toBe(false);
  });
  it("does not accumulate output for tabs that have never been opened", () => {
    const entry = mount("hidden");
    for (let i = 0; i < 1000; i++) terminals.handleOutput("hidden", "output");
    expect(entry.queue).toEqual([]);
    expect(entry.term.write).not.toHaveBeenCalled();
  });

  it("ignores scrollback replies after a terminal is destroyed", async () => {
    const entry = mount("closed");
    entry.opened = true;
    let resolve!: (data: string) => void;
    vi.mocked(pty.scrollback).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    terminals.resyncFromDaemon("closed");
    terminals.destroy("closed");
    resolve("old output");
    await Promise.resolve();
    expect(entry.term.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it("ignores an older scrollback reply after another resync starts", async () => {
    const entry = mount("resync");
    entry.opened = true;
    // Avoid the delayed repaint resize in this unit test.
    Object.assign(entry.term, { cols: 1 });
    let first!: (data: string) => void;
    let second!: (data: string) => void;
    vi.mocked(pty.scrollback)
      .mockImplementationOnce(() => new Promise((r) => { first = r; }))
      .mockImplementationOnce(() => new Promise((r) => { second = r; }));
    terminals.resyncFromDaemon("resync");
    terminals.resyncFromDaemon("resync");
    second("latest output");
    await Promise.resolve();
    first("outdated output");
    await Promise.resolve();
    expect(entry.term.write).toHaveBeenCalledExactlyOnceWith("latest output");
  });
});
