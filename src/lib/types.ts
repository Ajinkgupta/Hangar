export type Tab = "claude" | "shell" | "changes";
export type SessionKind = "claude" | "shell";

export type SavedCommand = { id: string; label: string; command: string };

export type ProjectLayout = {
  activeTab: Tab;
  diffView: "unified" | "split";
  browserOpen: boolean;
  splitDirection: "horizontal" | "vertical";
  splitRatio: number;
  portsOpen: boolean;
  browserUrl: string | null;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  claudeCommand: string;
  commands: SavedCommand[];
  layout: ProjectLayout;
};

export type Config = {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
};

export const defaultLayout = (): ProjectLayout => ({
  activeTab: "claude",
  diffView: "unified",
  browserOpen: false,
  splitDirection: "horizontal",
  splitRatio: 0.6,
  portsOpen: true,
  browserUrl: null,
});

export const emptyConfig = (): Config => ({ version: 1, projects: [], activeProjectId: null });

export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function newProject(path: string): Project {
  return {
    id: uid(),
    name: basename(path),
    path,
    claudeCommand: "claude",
    commands: [],
    layout: defaultLayout(),
  };
}

export function sessionId(projectId: string, kind: SessionKind): string {
  return `${projectId}:${kind}`;
}

export function projectOfSession(sessionId: string): string {
  return sessionId.split(":")[0];
}

/** Fills in any fields missing from an older/partial config. */
export function normalizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const r = raw as Partial<Config>;
  const projects = Array.isArray(r.projects) ? r.projects : [];
  return {
    version: 1,
    projects: projects
      .filter((p): p is Project => !!p && typeof p === "object" && typeof (p as Project).path === "string")
      .map((p) => ({
        id: p.id || uid(),
        name: p.name || basename(p.path),
        path: p.path,
        claudeCommand: p.claudeCommand || "claude",
        commands: Array.isArray(p.commands) ? p.commands : [],
        layout: { ...defaultLayout(), ...(p.layout || {}) },
      })),
    activeProjectId: typeof r.activeProjectId === "string" ? r.activeProjectId : null,
  };
}
