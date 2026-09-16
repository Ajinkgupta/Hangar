import { describe, expect, it } from "vitest";
import { deriveStatus, projectPort } from "./status";

const empty = { ports: [], activity: {}, error: null };

describe("deriveStatus", () => {
  it("is idle with live shells and nothing running", () => {
    const s = { "p:t1": { alive: true, pid: 1, exitCode: null }, "p:t2": { alive: true, pid: 2, exitCode: null } };
    expect(deriveStatus("p", s, empty)).toBe("idle");
  });
  it("is running when a session has child processes", () => {
    expect(deriveStatus("p", {}, { ...empty, activity: { "p:t1": 1 } })).toBe("running");
  });
  it("is running when the project owns a port", () => {
    const m = { ...empty, ports: [{ port: 3000, addr: "*", pid: 5, process: "node", session_id: "p:t2", conflict: false }] };
    expect(deriveStatus("p", {}, m)).toBe("running");
    expect(projectPort("p", m)).toBe(3000);
    expect(projectPort("q", m)).toBeNull();
  });
  it("is error when a session died, even if the other is busy", () => {
    const s = { "p:t2": { alive: false, pid: 2, exitCode: 1 } };
    expect(deriveStatus("p", s, { ...empty, activity: { "p:t1": 3 } })).toBe("error");
  });
});
