import { beforeEach, describe, expect, it, vi } from "vitest";

const { setError } = vi.hoisted(() => ({ setError: vi.fn() }));
vi.mock("../store", () => ({ useStore: { getState: () => ({ setError }) } }));
let values: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); setError.mockClear();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe("file drafts", () => {
  it("restores unsaved text and its disk baseline after a reload, and removes saved drafts", async () => {
    const { setFileDraft } = await import("./fileDrafts");
    setFileDraft("/project/a.ts", { base: "original", text: "my edits" });
    setFileDraft("/project/b.ts", { base: "other", text: "other edits" });
    vi.resetModules();
    const reloaded = await import("./fileDrafts");
    expect(reloaded.useFileDrafts.getState().drafts["/project/a.ts"]).toEqual({ base: "original", text: "my edits" });
    reloaded.setFileDraft("/project/a.ts", null);
    vi.resetModules();
    const saved = await import("./fileDrafts");
    expect(saved.useFileDrafts.getState().drafts["/project/a.ts"]).toBeUndefined();
    expect(saved.useFileDrafts.getState().drafts["/project/b.ts"].text).toBe("other edits");
  });
  it("keeps the draft in memory and surfaces storage failures", async () => {
    const { setFileDraft, useFileDrafts } = await import("./fileDrafts");
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("quota exceeded"); } });
    setFileDraft("/project/a.ts", { base: "old", text: "new" });
    expect(useFileDrafts.getState().drafts["/project/a.ts"].text).toBe("new");
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("Save the file before quitting"));
  });
  it("preserves CRLF, LF, and mixed line endings appropriately", async () => {
    const { fileTextForSave } = await import("./fileDrafts");
    expect(fileTextForSave("a\r\nb\r\n", "a\nbc\n")).toBe("a\r\nbc\r\n");
    expect(fileTextForSave("a\nb\n", "a\nbc\n")).toBe("a\nbc\n");
    expect(fileTextForSave("a\r\nb\n", "x\ny\n")).toBe("x\ny\n");
  });
});
