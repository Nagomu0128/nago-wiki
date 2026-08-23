import { describe, expect, it } from "vitest";
import {
  createPageRequestSchema,
  externalBotChannelIdSchema,
  replacePageAclRequestSchema,
  healthResponseSchema,
  updatePageRequestSchema,
  workspaceRoleSchema,
} from "./index";

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

  it("applies safe defaults to page creation", () => {
    expect(createPageRequestSchema.parse({ title: "Home" })).toMatchObject({
      accessMode: "workspace",
      bodyMd: "",
      parentId: null,
    });
  });

  it("requires optimistic concurrency for page updates", () => {
    expect(() => updatePageRequestSchema.parse({ bodyMd: "changed" })).toThrow();
    expect(
      updatePageRequestSchema.parse({ baseRevision: 3, bodyMd: "changed" }),
    ).toMatchObject({ baseRevision: 3 });
  });

  it("rejects duplicate members in an ACL replacement", () => {
    const userId = "00000000-0000-7000-8000-000000000010";
    expect(() =>
      replacePageAclRequestSchema.parse({
        baseRevision: 0,
        entries: [
          { userId, permission: "viewer" },
          { userId, permission: "editor" },
        ],
      }),
    ).toThrow();
  });

  it("keeps bot channel ids safe for route segments", () => {
    expect(externalBotChannelIdSchema.parse("discord:team_channel-123")).toBe(
      "discord:team_channel-123",
    );
    expect(() => externalBotChannelIdSchema.parse("team/private")).toThrow();
  });
});
