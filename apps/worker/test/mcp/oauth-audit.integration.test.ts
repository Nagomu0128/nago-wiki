import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createUuidV7 } from "../../src/core/ids";
import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";
import { recordMcpOAuthGrantAudit } from "../../src/mcp/oauth";

describe("MCP OAuth grant audit", () => {
  let memberId: string;

  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM audit_events WHERE action = 'mcp.oauth.granted'",
    ).run();
    await env.DB.prepare(
      "DELETE FROM users WHERE email = 'mcp-grant@example.com'",
    ).run();
    memberId = createUuidV7();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'mcp-grant@example.com', 'MCP Grant', 'viewer', 'active', ?3, ?3)`,
    )
      .bind(memberId, DEFAULT_WORKSPACE_ID, now)
      .run();
  });

  it("records the member, client, and actually granted scope without credentials", async () => {
    await recordMcpOAuthGrantAudit(env.DB, {
      memberId,
      clientId: "registered-client-id",
      clientName: "Desktop LLM",
      scopes: ["wiki:read", "unsupported:scope"],
    });

    const event = await env.DB.prepare(
      `SELECT actor_id, action, target_type, target_id, metadata_json
         FROM audit_events
        WHERE action = 'mcp.oauth.granted'`,
    ).first<{
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      metadata_json: string;
    }>();
    expect(event).toMatchObject({
      actor_id: memberId,
      action: "mcp.oauth.granted",
      target_type: "user",
      target_id: memberId,
    });
    expect(JSON.parse(event?.metadata_json ?? "null")).toEqual({
      clientId: "registered-client-id",
      clientName: "Desktop LLM",
      scopes: ["wiki:read"],
    });
  });
});
