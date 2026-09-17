/** Active tab is either a terminal id or the special "changes" view. */
export type Tab = string;
export const CHANGES_TAB = "changes";
export const FILES_TAB = "files";
export const TASKS_TAB = "tasks";
export const SPECIAL_TABS = [FILES_TAB, CHANGES_TAB, TASKS_TAB];

export type SavedCommand = { id: string; label: string; command: string };
export type Task = { id: string; text: string; done: boolean; createdAt: number };
export type ThemeName = "hangar" | "midnight" | "graphite" | "light";
export type Settings = {
  theme: ThemeName;
  fontSize: number;
  notifications: boolean;
  sound: boolean;
};
export const defaultSettings = (): Settings => ({ theme: "hangar", fontSize: 13, notifications: true, sound: true });

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
  /** saved command id -> the terminal tab it last ran in (commands own their tab) */
  commandRuns: Record<string, string>;
  tasks: Task[];
  layout: ProjectLayout;
};

export type Config = {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
  connections: Connection[];
  /** connection id -> the SSH terminal tab it runs in (connections own their tab) */
  connectionRuns: Record<string, string>;
  settings: Settings;
};

export function sshProject(): Project {
  return {
    id: SSH_PROJECT_ID,
    name: "SSH & bastions",
    path: "~",
    kind: "ssh",
    terminals: [],
    commands: [],
    commandRuns: {},
    tasks: [],
    layout: { ...defaultLayout(), portsOpen: false, activeTab: "" },
  };
}

export const defaultLayout = (): ProjectLayout => ({
  activeTab: "",
  diffView: "unified",
  portsOpen: true,
});

export const emptyConfig = (): Config => ({
  version: 1,
  projects: [sshProject()],
  activeProjectId: null,
  connections: [],
  connectionRuns: {},
  settings: defaultSettings(),
});

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
    commandRuns: {},
    tasks: [],
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
        .map((c) => ({
          id: c.id || uid(),
          name: c.name || c.command,
          command: c.command,
          steps: Array.isArray(c.steps) ? c.steps.filter((s) => s && typeof s.expect === "string") : [],
        }))
    : [];
  const rs = (r.settings || {}) as Partial<Settings>;
  const settings: Settings = {
    ...defaultSettings(),
    ...(rs.theme === "hangar" || rs.theme === "midnight" || rs.theme === "graphite" || rs.theme === "light" ? { theme: rs.theme } : {}),
    ...(typeof rs.fontSize === "number" && rs.fontSize >= 10 && rs.fontSize <= 22 ? { fontSize: rs.fontSize } : {}),
    ...(typeof rs.notifications === "boolean" ? { notifications: rs.notifications } : {}),
    ...(typeof rs.sound === "boolean" ? { sound: rs.sound } : {}),
  };
  const normalized: Config = {
    version: 1,
    connections,
    connectionRuns: r.connectionRuns && typeof r.connectionRuns === "object" ? r.connectionRuns : {},
    settings,
    projects: projects
      .filter((p): p is Project => !!p && typeof p === "object" && typeof (p as Project).path === "string")
      .map((p) => {
        const seen = new Set<string>();
        const rawTerminals: TerminalTab[] = Array.isArray(p.terminals)
          ? p.terminals
              .filter((t) => t && typeof t === "object")
              .map((t) => {
                let id = typeof t.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(t.id) ? t.id : uid().slice(0, 8);
                while (seen.has(id)) id = uid().slice(0, 8);
                seen.add(id);
                return { id, name: typeof t.name === "string" && t.name ? t.name : "terminal" };
              })
          : [];
        const terminals: TerminalTab[] = rawTerminals.length ? rawTerminals : [{ id: uid().slice(0, 8), name: "main" }];
        const raw = (p.layout || {}) as Partial<ProjectLayout>;
        const layout: ProjectLayout = {
          ...defaultLayout(),
          ...(raw.activeTab !== undefined ? { activeTab: raw.activeTab } : {}),
          ...(raw.diffView === "split" || raw.diffView === "unified" ? { diffView: raw.diffView } : {}),
          ...(typeof raw.portsOpen === "boolean" ? { portsOpen: raw.portsOpen } : {}),
        };
        if (!SPECIAL_TABS.includes(layout.activeTab) && !terminals.some((t) => t.id === layout.activeTab)) {
          layout.activeTab = terminals[0]?.id ?? "";
        }
        const kind = p.kind === "ssh" || p.id === SSH_PROJECT_ID ? ("ssh" as const) : undefined;
        return {
          id: p.id || uid(),
          name: p.name || basename(p.path),
          path: p.path,
          ...(kind ? { kind } : {}),
          terminals: kind ? (Array.isArray(p.terminals) ? p.terminals : []) : terminals,
          commands: Array.isArray(p.commands)
            ? p.commands.filter((c) => c && typeof c.command === "string").map((c) => ({ ...c, id: c.id || uid(), label: c.label || c.command }))
            : kind
              ? []
              : defaultCommands(),
          commandRuns: p.commandRuns && typeof p.commandRuns === "object" ? p.commandRuns : {},
          tasks: Array.isArray(p.tasks)
            ? p.tasks.filter((t) => t && typeof t.text === "string").map((t) => ({ id: t.id || uid(), text: t.text, done: !!t.done, createdAt: t.createdAt || 0 }))
            : [],
          layout,
        };
      }),
    activeProjectId: typeof r.activeProjectId === "string" ? r.activeProjectId : null,
  };
  if (!normalized.projects.some((p) => p.kind === "ssh")) normalized.projects.push(sshProject());
  return normalized;
}
