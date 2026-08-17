import { describe, expect, it } from "vitest";

import { pageRoomKey } from "../src/realtime/types";

describe("page room routing", () => {
  it("creates a deterministic one-page room key", () => {
    expect(pageRoomKey("workspace-1", "page-1")).toBe(
      "workspace-1:page-1",
    );
  });

  it("rejects ambiguous identifiers", () => {
    expect(() => pageRoomKey("workspace:other", "page-1")).toThrow(
      /colon-free/u,
    );
  });
});
