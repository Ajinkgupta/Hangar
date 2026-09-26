import { create } from "zustand";
import { useStore } from "../store";

export type FileDraft = { base: string; text: string };
const STORAGE_KEY = "hangar.file-drafts.v1";
function load(): Record<string, FileDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, d]) => d && typeof d.base === "string" && typeof d.text === "string"));
  } catch { return {}; }
}
export const useFileDrafts = create<{ drafts: Record<string, FileDraft> }>(() => ({ drafts: load() }));

export function setFileDraft(path: string, draft: FileDraft | null) {
  const drafts = { ...useFileDrafts.getState().drafts };
  if (draft) drafts[path] = draft;
  else delete drafts[path];
  useFileDrafts.setState({ drafts });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts)); }
  catch { useStore.getState().setError("Your edit is kept in memory, but draft storage is full. Save the file before quitting Hangar."); }
}

/** Preserve CRLF files when textarea input normalizes line endings. */
export function fileTextForSave(base: string, text: string): string {
  return base.includes("\r\n") && !base.replaceAll("\r\n", "").includes("\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}
