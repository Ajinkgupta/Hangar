/** Active tab is either a terminal id or the special "changes" view. */
export type Tab = string;
export const CHANGES_TAB = "changes";

export type SavedCommand = { id: string; label: string; command: string };

/** One automation step: when the terminal output matches `expect` (regex, case-insensitive),
 *  send `send` + Enter. A secret step keeps its value in the macOS Keychain. */
export type ConnectionStep = { expect: string; send: string; secretRef?: string };
export type Connection = { id: string; name: string; command: string; steps: ConnectionStep[] };
export const SSH_PROJECT_ID = "ssh";
export type TerminalTab = { id: string; name: string };

export type ProjectLayout = {
  activeTab: Tab;
  diffView: "unified" | "split";
  portsOpen: boolean;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  kind?: "ssh";
  terminals: TerminalTab[];
  commands: SavedCommand[];
  layout: ProjectLayout;
};

export type Config = {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
  connections: Connection[];
};

export function sshProject(): Project {
  return {
    id: SSH_PROJECT_ID,
    name: "SSH & bastions",
    path: "~",
    kind: "ssh",
    terminals: [],
    commands: [],
    layout: { ...defaultLayout(), portsOpen: false, activeTab: "" },
  };
}

export const defaultLayout = (): ProjectLayout => ({
  activeTab: "",
  diffView: "unified",
  portsOpen: true,
});

export const emptyConfig = (): Config => ({ version: 1, projects: [sshProject()], activeProjectId: null, connections: [] });

export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function uid(): string {
  return crypto.randomUUID();
}

export const defaultCommands = (): SavedCommand[] => [
  { id: uid(), label: "claude", command: "claude" },
  { id: uid(), label: "claude --resume", command: "claude --resume" },
];

export function newProject(path: string): Project {
  const first: TerminalTab = { id: uid().slice(0, 8), name: "main" };
  return {
    id: uid(),
    name: basename(path),
    path,
    terminals: [first],
    commands: defaultCommands(),
    layout: { ...defaultLayout(), activeTab: first.id },
  };
}

export function sessionId(projectId: string, terminalId: string): string {
  return `${projectId}:${terminalId}`;
}

/** Next unused "terminal N" name. */
export function nextTerminalName(existing: TerminalTab[]): string {
  const taken = new Set(existing.map((t) => t.name));
  for (let i = existing.length + 1; ; i++) {
    const n = `term ${i}`;
    if (!taken.has(n)) return n;
  }
}

export function projectOfSession(sessionId: string): string {
  return sessionId.split(":")[0];
}

/** Fills in any fields missing from an older/partial config. */
export function normalizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const r = raw as Partial<Config>;
  const projects = Array.isArray(r.projects) ? r.projects : [];
  const connections: Connection[] = Array.isArray(r.connections)
    ? r.connections
        .filter((c): c is Connection => !!c && typeof c === "object" && typeof (c as Connection).command === "string")
        .map((c) => ({ id: c.id || uid(), name: c.name || c.command, command: c.command, steps: Array.isArray(c.steps) ? c.steps : [] }))
    : [];
  const normalized: Config = {
    version: 1,
    connections,
    projects: projects
      .filter((p): p is Project => !!p && typeof p === "object" && typeof (p as Project).path === "string")
      .map((p) => {
        const terminals: TerminalTab[] =
          Array.isArray(p.terminals) && p.terminals.length ? p.terminals : [{ id: uid().slice(0, 8), name: "main" }];
        const raw = (p.layout || {}) as Partial<ProjectLayout>;
        const layout: ProjectLayout = {
          ...defaultLayout(),
          ...(raw.activeTab !== undefined ? { activeTab: raw.activeTab } : {}),
          ...(raw.diffView === "split" || raw.diffView === "unified" ? { diffView: raw.diffView } : {}),
          ...(typeof raw.portsOpen === "boolean" ? { portsOpen: raw.portsOpen } : {}),
        };
        if (layout.activeTab !== CHANGES_TAB && !terminals.some((t) => t.id === layout.activeTab)) {
          layout.activeTab = terminals[0]?.id ?? "";
        }
        const kind = p.kind === "ssh" || p.id === SSH_PROJECT_ID ? ("ssh" as const) : undefined;
        return {
          id: p.id || uid(),
          name: p.name || basename(p.path),
          path: p.path,
          ...(kind ? { kind } : {}),
          terminals: kind ? (Array.isArray(p.terminals) ? p.terminals : []) : terminals,
          commands: Array.isArray(p.commands) ? p.commands : kind ? [] : defaultCommands(),
          layout,
        };
      }),
    activeProjectId: typeof r.activeProjectId === "string" ? r.activeProjectId : null,
  };
  if (!normalized.projects.some((p) => p.kind === "ssh")) normalized.projects.push(sshProject());
  return normalized;
}
