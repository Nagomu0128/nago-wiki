import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../../src/mcp/pagination";

describe("MCP pagination cursors", () => {
  it("round-trips opaque UTF-8 keyset cursors", () => {
    const cursor = { sortTitle: "日本語のページ", id: "page-123" };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed and oversized cursors", () => {
    expect(decodeCursor("not-base64!")).toBeNull();
    const oversized = encodeCursor({ sortTitle: "x".repeat(501), id: "page-123" });
    expect(decodeCursor(oversized)).toBeNull();
  });
});
