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
});
