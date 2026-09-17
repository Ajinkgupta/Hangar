import type { ThemeName } from "./types";
import type { TermTheme } from "./terminals";

export type Theme = {
  name: ThemeName;
  label: string;
  vars: Record<string, string>;
  term: TermTheme;
};

export const THEMES: Theme[] = [
  {
    name: "hangar",
    label: "Hangar (teal)",
    vars: { "--bg": "#0f1115", "--bg-2": "#151821", "--bg-3": "#1b1f2a", "--border": "#262b38", "--fg": "#d6dbe5", "--fg-muted": "#7d8595", "--accent": "#5eead4", "--accent-dim": "rgba(94,234,212,0.15)" },
    term: { background: "#0f1115", foreground: "#d6dbe5", cursor: "#5eead4", selectionBackground: "rgba(94,234,212,0.25)" },
  },
  {
    name: "midnight",
    label: "Midnight (blue)",
    vars: { "--bg": "#0b0f1a", "--bg-2": "#111827", "--bg-3": "#1a2236", "--border": "#243049", "--fg": "#dbe4f5", "--fg-muted": "#7f8db0", "--accent": "#7aa2ff", "--accent-dim": "rgba(122,162,255,0.16)" },
    term: { background: "#0b0f1a", foreground: "#dbe4f5", cursor: "#7aa2ff", selectionBackground: "rgba(122,162,255,0.25)" },
  },
  {
    name: "graphite",
    label: "Graphite (amber)",
    vars: { "--bg": "#111111", "--bg-2": "#181818", "--bg-3": "#222222", "--border": "#2e2e2e", "--fg": "#e6e2da", "--fg-muted": "#8a8680", "--accent": "#f5b544", "--accent-dim": "rgba(245,181,68,0.16)" },
    term: { background: "#111111", foreground: "#e6e2da", cursor: "#f5b544", selectionBackground: "rgba(245,181,68,0.25)" },
  },
  {
    name: "light",
    label: "Light",
    vars: { "--bg": "#ffffff", "--bg-2": "#f4f5f8", "--bg-3": "#e9ebf0", "--border": "#d7dae2", "--fg": "#1d2230", "--fg-muted": "#6b7280", "--accent": "#0f9d8a", "--accent-dim": "rgba(15,157,138,0.14)" },
    term: { background: "#ffffff", foreground: "#1d2230", cursor: "#0f9d8a", selectionBackground: "rgba(15,157,138,0.25)" },
  },
];

export function themeByName(name: ThemeName): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

/** Writes the theme's CSS variables onto :root. */
export function applyThemeVars(theme: Theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.name;
}
