import { describe, expect, it, vi } from "vitest";

const writes: string[] = [];
vi.mock("./ipc", () => ({
  pty: { write: (_id: string, data: string) => (writes.push(atob(data)), Promise.resolve()) },
  b64decode: (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)),
  b64encode: (s: string) => btoa(s),
}));

const { automation, stripAnsi } = await import("./automation");
const enc = (s: string) => btoa(s);

describe("automation", () => {
  it("sends each step when its prompt appears, in order, then finishes", () => {
    const done = vi.fn();
    automation.start("s1", [
      { expect: "password:", send: "", resolved: "hunter2" },
      { expect: "\\$ $", send: "cd /app", resolved: "cd /app" },
    ], { onDone: done });
    automation.feed("s1", enc("Connecting...\r\n"));
    expect(writes).toEqual([]);
    automation.feed("s1", enc("user@bastion's \x1b[1mpassword:\x1b[0m "));
    expect(writes).toEqual(["hunter2\r"]);
    automation.feed("s1", enc("Welcome\r\nuser@host:~$ "));
    expect(writes).toEqual(["hunter2\r", "cd /app\r"]);
    expect(done).toHaveBeenCalled();
    expect(automation.isRunning("s1")).toBe(false);
  });

  it("ignores output for sessions without a script and strips ansi", () => {
    automation.feed("nope", enc("password:"));
    expect(stripAnsi("\x1b[32mok\x1b[0m")).toBe("ok");
  });

  it("cancels the previous script when replaced with no steps", () => {
    const oldDone = vi.fn();
    const done = vi.fn();
    automation.start("replace", [{ expect: "password:", send: "", resolved: "old-secret" }], { onDone: oldDone });
    automation.start("replace", [], { onDone: done });
    const before = writes.length;
    automation.feed("replace", enc("password:"));
    expect(writes).toHaveLength(before);
    expect(automation.isRunning("replace")).toBe(false);
    expect(oldDone).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });
});
