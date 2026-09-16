export type DiffLineType = "add" | "del" | "ctx" | "meta";
export type DiffLine = { type: DiffLineType; oldNo: number | null; newNo: number | null; text: string };
export type Hunk = { header: string; lines: DiffLine[] };
export type ParsedDiff = { hunks: Hunk[]; binary: boolean; additions: number; deletions: number; empty: boolean };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parses a single-file unified diff as produced by `git diff --no-color`. */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const hunks: Hunk[] = [];
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of raw.split("\n")) {
    if (cur === null) {
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      const m = HUNK_RE.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[3], 10);
        cur = { header: line, lines: [] };
        hunks.push(cur);
      }
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[3], 10);
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (line.startsWith("+")) {
      cur.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
      additions++;
    } else if (line.startsWith("-")) {
      cur.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
      deletions++;
    } else if (line.startsWith("\\")) {
      cur.lines.push({ type: "meta", oldNo: null, newNo: null, text: line.slice(2) });
    } else if (line.startsWith(" ")) {
      cur.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (line === "") {
      // trailing newline of the diff output; ignore
    } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      cur = null; // next file header (shouldn't happen for single-file diffs)
    }
  }
  return { hunks, binary, additions, deletions, empty: hunks.length === 0 && !binary };
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** Pairs deletions with additions inside each hunk for a side-by-side view. */
export function toSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  const lines = hunk.lines;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "ctx" || l.type === "meta") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
