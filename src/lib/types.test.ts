import { describe, expect, it } from "vitest";
import { normalizeConfig, sshProject } from "./types";

describe("SSH config restoration", () => {
  it("keeps an empty SSH project without selecting a nonexistent terminal", () => {
    const ssh = sshProject();
    ssh.layout.activeTab = "files";
    const project = normalizeConfig({ projects: [ssh] }).projects[0];
    expect(project.terminals).toEqual([]);
    expect(project.layout.activeTab).toBe("");
  });

  it("normalizes SSH terminal IDs and selects an existing terminal", () => {
    const ssh = sshProject();
    ssh.terminals = [{ id: "invalid:id", name: "shell" }, { id: "valid", name: "second" }, { id: "valid", name: "third" }];
    const project = normalizeConfig({ projects: [ssh] }).projects[0];
    expect(new Set(project.terminals.map((t) => t.id)).size).toBe(3);
    expect(project.terminals.every((t) => /^[A-Za-z0-9_-]{1,32}$/.test(t.id))).toBe(true);
    expect(project.layout.activeTab).toBe(project.terminals[0].id);
  });
});
