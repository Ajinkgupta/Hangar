import { toSplitRows, type DiffLine, type ParsedDiff } from "../lib/diff";

export function DiffView({ diff, mode }: { diff: ParsedDiff; mode: "unified" | "split" }) {
  if (diff.binary) return <div className="muted pad">Binary file changed.</div>;
  if (diff.empty) return <div className="muted pad">No textual changes (maybe only mode or whitespace-insensitive).</div>;
  return (
    <div className="diff-scroll">
      <table className={"diff " + mode}>
        <tbody>
          {diff.hunks.map((h, hi) =>
            mode === "unified" ? (
              <UnifiedHunk key={hi} header={h.header} lines={h.lines} />
            ) : (
              <SplitHunk key={hi} header={h.header} rows={toSplitRows(h)} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedHunk({ header, lines }: { header: string; lines: DiffLine[] }) {
  return (
    <>
      <tr className="hunk">
        <td className="num" />
        <td className="num" />
        <td className="code" colSpan={1}>{header}</td>
      </tr>
      {lines.map((l, i) => (
        <tr key={i} className={"line " + l.type}>
          <td className="num">{l.oldNo ?? ""}</td>
          <td className="num">{l.newNo ?? ""}</td>
          <td className="code">
            <span className="marker">{l.type === "add" ? "+" : l.type === "del" ? "-" : l.type === "meta" ? "\\" : " "}</span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}

function SplitHunk({ header, rows }: { header: string; rows: ReturnType<typeof toSplitRows> }) {
  return (
    <>
      <tr className="hunk">
        <td className="num" />
        <td className="code" colSpan={3}>{header}</td>
      </tr>
      {rows.map((r, i) => (
        <tr key={i} className="line">
          <td className={"num " + (r.left?.type ?? "empty")}>{r.left?.oldNo ?? ""}</td>
          <td className={"code " + (r.left?.type ?? "empty")}>{r.left ? r.left.text : ""}</td>
          <td className={"num " + (r.right?.type ?? "empty")}>{r.right?.newNo ?? ""}</td>
          <td className={"code " + (r.right?.type ?? "empty")}>{r.right ? r.right.text : ""}</td>
        </tr>
      ))}
    </>
  );
}
