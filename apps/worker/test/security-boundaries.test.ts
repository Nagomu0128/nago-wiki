import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { D1SearchCandidateAuthorizer } from "../src/ai/authorizer";
import { consumeBotRateLimit } from "../src/bots/service";
import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";

const otherWorkspaceId = "00000000-0000-7000-8000-000000000002";
const memberId = "00000000-0000-7000-8000-000000000010";
const otherMemberId = "00000000-0000-7000-8000-000000000011";
const otherPageId = "00000000-0000-7000-8000-000000000020";
const contentHash = "a".repeat(64);

describe("cross-surface security boundaries", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM bot_rate_limits`),
      env.DB.prepare(`DELETE FROM pages`),
      env.DB.prepare(`DELETE FROM users`),
      env.DB.prepare(`DELETE FROM workspaces WHERE id <> ?1`).bind(
        DEFAULT_WORKSPACE_ID,
      ),
    ]);
  });

  it("never authorizes an AI Search candidate from another workspace", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Other', ?2)`,
      ).bind(otherWorkspaceId, now),
      userStatement(memberId, DEFAULT_WORKSPACE_ID, "member@example.com", now),
      userStatement(otherMemberId, otherWorkspaceId, "other@example.com", now),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, parent_id, slug, title, body_md, revision,
            content_hash, access_mode, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, NULL, 'secret', 'Secret', 'private', 1, ?3,
                 'workspace', 'active', ?4, ?5, ?5)`,
      ).bind(otherPageId, otherWorkspaceId, contentHash, otherMemberId, now),
    ]);

    const result = await new D1SearchCandidateAuthorizer(
      env.DB,
      "https://wiki.example",
    ).authorize(
      memberId,
      {
        chunkId: "chunk",
        key: "other.md",
        pageId: otherPageId,
        workspaceId: otherWorkspaceId,
        contentHash,
        text: "private",
        score: 1,
      },
      {},
    );

    expect(result).toBeNull();
  });

  it("limits each bot-linked user to five requests per minute", async () => {
    for (let count = 0; count < 5; count += 1) {
      await expect(
        consumeBotRateLimit(env.DB, memberId, DEFAULT_WORKSPACE_ID),
      ).resolves.toBe(true);
    }
    await expect(
      consumeBotRateLimit(env.DB, memberId, DEFAULT_WORKSPACE_ID),
    ).resolves.toBe(false);
  });
});

function userStatement(
  id: string,
  workspaceId: string,
  email: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO users
       (id, workspace_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Member', 'viewer', 'active', ?4, ?4)`,
  ).bind(id, workspaceId, email, now);
}
