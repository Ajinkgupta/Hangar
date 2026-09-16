import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, toSplitRows } from "./diff";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export {};
 // end
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  it("parses hunks with correct line numbers and counts", () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    const l = d.hunks[0].lines;
    expect(l[0]).toEqual({ type: "ctx", oldNo: 1, newNo: 1, text: "const a = 1;" });
    expect(l[1]).toEqual({ type: "del", oldNo: 2, newNo: null, text: "const b = 2;" });
    expect(l[2]).toEqual({ type: "add", oldNo: null, newNo: 2, text: "const b = 3;" });
    expect(l[3]).toEqual({ type: "add", oldNo: null, newNo: 3, text: "const c = 4;" });
    expect(l[4]).toEqual({ type: "ctx", oldNo: 3, newNo: 4, text: "export {};" });
    expect(l[6].type).toBe("meta");
  });

  it("detects binary and empty diffs", () => {
    expect(parseUnifiedDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n").binary).toBe(true);
    expect(parseUnifiedDiff("").empty).toBe(true);
  });

  it("pairs deletions with additions for split view", () => {
    const rows = toSplitRows(parseUnifiedDiff(SAMPLE).hunks[0]);
    expect(rows[0].left?.text).toBe("const a = 1;");
    expect(rows[1].left?.text).toBe("const b = 2;");
    expect(rows[1].right?.text).toBe("const b = 3;");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe("const c = 4;");
  });
});
