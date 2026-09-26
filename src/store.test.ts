import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConfig, newProject, sessionId } from "./lib/types";

vi.mock("./lib/ipc", () => ({
  config: { save: vi.fn().mockResolvedValue(undefined) },
  pty: { forget: vi.fn().mockResolvedValue(undefined), create: vi.fn(), kill: vi.fn().mockResolvedValue(undefined) },
  secrets: { set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("./lib/terminals", () => ({ terminals: { destroy: vi.fn() } }));
vi.mock("./lib/automation", () => ({ automation: { stop: vi.fn() } }));
const { useStore } = await import("./store");
const { pty, secrets } = await import("./lib/ipc");

describe("terminal cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ config: emptyConfig(), loaded: false, sessions: {}, attention: {}, lastOutput: {}, connecting: {}, launchedAt: {} });
  });

  for (const action of ["close", "remove"] as const) {
    it(`${action} clears all session badges while preserving other sessions`, async () => {
      const project = newProject("/tmp/project");
      const sid = sessionId(project.id, project.terminals[0].id);
      const values = { [sid]: 123, other: 456 };
      useStore.setState({
        config: { ...emptyConfig(), projects: [project] },
        attention: values, lastOutput: values, launchedAt: values,
        connecting: { [sid]: "running", other: "done" },
      });
      if (action === "close") await useStore.getState().closeTerminal(project.id, project.terminals[0].id);
      else await useStore.getState().removeProject(project.id);
      for (const key of ["attention", "lastOutput", "launchedAt"] as const) {
        expect(useStore.getState()[key]).toEqual({ other: 456 });
      }
      expect(useStore.getState().connecting).toEqual({ other: "done" });
      expect(pty.forget).toHaveBeenCalledWith(sid);
    });
  }

  it("does not send terminal commands for special tabs", async () => {
    const project = newProject("/tmp/project");
    useStore.setState({ config: { ...emptyConfig(), projects: [project] } });
    await useStore.getState().closeTerminal(project.id, "files");
    expect(pty.forget).not.toHaveBeenCalled();
    expect(useStore.getState().config.projects[0]).toEqual(project);
  });

  it("does not overwrite a retained password after connection steps move", async () => {
    const retainedKey = "hangar-conn-connection-1";
    await useStore.getState().saveConnection({
      id: "connection", name: "SSH", command: "ssh host", steps: [
        { expect: "first password:", send: "", secretRef: retainedKey },
        { expect: "second password:", send: "" },
      ],
    }, { 1: "new-password" });
    const steps = useStore.getState().config.connections[0].steps;
    expect(steps[0].secretRef).toBe(retainedKey);
    expect(steps[1].secretRef).not.toBe(retainedKey);
    expect(secrets.set).toHaveBeenCalledWith(steps[1].secretRef, "new-password");
    expect(JSON.stringify(useStore.getState().config)).not.toContain("new-password");
  });

  it("forgets a terminal closed while its shell is still starting", async () => {
    const project = newProject("/tmp/project");
    useStore.setState({ config: { ...emptyConfig(), projects: [project] } });
    let resolve!: (pid: number) => void;
    vi.mocked(pty.create).mockImplementationOnce(() => new Promise<number>((r) => { resolve = r; }));
    const opening = useStore.getState().addTerminal(project.id);
    const tab = useStore.getState().config.projects[0].terminals[1];
    await useStore.getState().closeTerminal(project.id, tab.id);
    resolve(42);
    expect(await opening).toBe("");
    expect(useStore.getState().sessions[sessionId(project.id, tab.id)]).toBeUndefined();
    expect(pty.forget).toHaveBeenCalledTimes(2);
  });

  it("leaves failed shell launches restartable and does not report success", async () => {
    const project = newProject("/tmp/project");
    useStore.setState({ config: { ...emptyConfig(), projects: [project] } });
    vi.mocked(pty.create).mockRejectedValueOnce(new Error("missing directory"));
    expect(await useStore.getState().addTerminal(project.id)).toBe("");
    const tab = useStore.getState().config.projects[0].terminals[1];
    expect(useStore.getState().sessions[sessionId(project.id, tab.id)].alive).toBe(false);
    expect(useStore.getState().lastError).toContain("missing directory");
  });

  it("stops only the selected terminal and keeps the other sessions running", async () => {
    const project = newProject("/tmp/project");
    project.terminals.push({ id: "second", name: "second" });
    const selected = sessionId(project.id, project.terminals[0].id);
    const other = sessionId(project.id, "second");
    const alive = { alive: true, pid: 42, exitCode: null };
    useStore.setState({
      config: { ...emptyConfig(), projects: [project] },
      sessions: { [selected]: alive, [other]: alive, "another:terminal": alive },
      attention: { [selected]: 123, [other]: 456 },
      connecting: { [selected]: "running", [other]: "running" },
    });
    await useStore.getState().stopSession(project.id, project.terminals[0].id);
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith(selected);
    expect(useStore.getState().sessions[selected].alive).toBe(false);
    expect(useStore.getState().sessions[other]).toEqual(alive);
    expect(useStore.getState().sessions["another:terminal"]).toEqual(alive);
    expect(useStore.getState().attention).toEqual({ [other]: 456 });
    expect(useStore.getState().connecting).toEqual({ [other]: "running" });
    expect(useStore.getState().config.projects[0].terminals).toHaveLength(2);
  });

  it("does not mark a terminal stopped when the daemon rejects the request", async () => {
    const project = newProject("/tmp/project");
    const sid = sessionId(project.id, project.terminals[0].id);
    useStore.setState({
      config: { ...emptyConfig(), projects: [project] },
      sessions: { [sid]: { alive: true, pid: 42, exitCode: null } },
    });
    vi.mocked(pty.kill).mockRejectedValueOnce(new Error("daemon disconnected"));
    await useStore.getState().stopSession(project.id, project.terminals[0].id);
    expect(useStore.getState().sessions[sid].alive).toBe(true);
    expect(useStore.getState().lastError).toContain("Could not stop terminal");
  });

  it("ignores stop requests for non-terminal tabs", async () => {
    const project = newProject("/tmp/project");
    useStore.setState({ config: { ...emptyConfig(), projects: [project] } });
    for (const tab of ["files", "changes", "tasks", "missing"]) {
      await useStore.getState().stopSession(project.id, tab);
    }
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("preserves SSH and omitted projects when reordering the sidebar", () => {
    const first = newProject("/tmp/first");
    const second = newProject("/tmp/second");
    const config = emptyConfig();
    const ssh = config.projects[0];
    useStore.setState({ config: { ...config, projects: [first, second, ssh] } });
    useStore.getState().reorderProjects([second.id, first.id, second.id, "missing"]);
    expect(useStore.getState().config.projects.map((p) => p.id)).toEqual([second.id, first.id, ssh.id]);
    expect(useStore.getState().config.projects[2]).toEqual(ssh);
  });
});
