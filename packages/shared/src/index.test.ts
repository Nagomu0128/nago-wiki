import { describe, expect, it } from "vitest";
import { healthResponseSchema, workspaceRoleSchema } from "./index";

describe("shared contracts", () => {
  it("accepts supported workspace roles", () => {
    expect(workspaceRoleSchema.parse("editor")).toBe("editor");
  });

  it("rejects a health response without an ISO timestamp", () => {
    expect(() =>
      healthResponseSchema.parse({
        ok: true,
        service: "nago-wiki",
        timestamp: "today",
      }),
    ).toThrow();
  });
});
