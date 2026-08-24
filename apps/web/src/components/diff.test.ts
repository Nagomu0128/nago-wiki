import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("keeps context and marks imported additions and removals", () => {
    expect(diffLines("# Note\nold\nkeep", "# Note\nnew\nkeep")).toEqual([
      { kind: "same", value: "# Note" },
      { kind: "removed", value: "old" },
      { kind: "added", value: "new" },
      { kind: "same", value: "keep" },
    ]);
  });

  it("uses bounded memory for large line-oriented documents", () => {
    const before = ["heading", ...Array.from({ length: 2_000 }, (_, index) => `old ${String(index)}`), "footer"].join("\n");
    const after = ["heading", ...Array.from({ length: 2_000 }, (_, index) => `new ${String(index)}`), "footer"].join("\n");

    const result = diffLines(before, after);

    expect(result[0]).toEqual({ kind: "same", value: "heading" });
    expect(result.at(-1)).toEqual({ kind: "same", value: "footer" });
    expect(result.filter((line) => line.kind === "removed")).toHaveLength(2_000);
    expect(result.filter((line) => line.kind === "added")).toHaveLength(2_000);
  });
});
