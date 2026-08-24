import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createUuidV7 } from "../../src/core/ids";
import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";
import { resolveCurrentMcpAuth } from "../../src/mcp/handler";
import type { McpAuthProps } from "../../src/mcp/types";

describe("MCP request identity revalidation", () => {
  let memberId: string;
  let props: McpAuthProps;

  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM users WHERE email = 'mcp-current-member@example.com'",
    ).run();
    memberId = createUuidV7();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'mcp-current-member@example.com', 'Current Member',
               'viewer', 'active', ?3, ?3)`,
    )
      .bind(memberId, DEFAULT_WORKSPACE_ID, now)
      .run();
    props = {
      userId: memberId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      email: "stale@example.com",
      displayName: "Stale name",
      role: "owner",
      scopes: ["wiki:read"],
    };
  });

  it("loads the current active member role and profile on every request", async () => {
    await expect(
      resolveCurrentMcpAuth(env.DB, DEFAULT_WORKSPACE_ID, props),
    ).resolves.toEqual({
      userId: memberId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      email: "mcp-current-member@example.com",
      displayName: "Current Member",
      role: "viewer",
      scopes: ["wiki:read"],
    });

    await env.DB.prepare(
      "UPDATE users SET role = 'editor', display_name = 'Renamed Member' WHERE id = ?1",
    )
      .bind(memberId)
      .run();
    await expect(
      resolveCurrentMcpAuth(env.DB, DEFAULT_WORKSPACE_ID, props),
    ).resolves.toMatchObject({ role: "editor", displayName: "Renamed Member" });
  });

  it("rejects suspended, deleted, and cross-workspace token identities alike", async () => {
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1")
      .bind(memberId)
      .run();
    await expect(
      resolveCurrentMcpAuth(env.DB, DEFAULT_WORKSPACE_ID, props),
    ).resolves.toBeNull();

    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(memberId).run();
    await expect(
      resolveCurrentMcpAuth(env.DB, DEFAULT_WORKSPACE_ID, props),
    ).resolves.toBeNull();
    await expect(
      resolveCurrentMcpAuth(env.DB, createUuidV7(), props),
    ).resolves.toBeNull();
  });
});
