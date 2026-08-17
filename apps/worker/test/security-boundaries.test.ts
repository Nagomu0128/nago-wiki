import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { D1SearchCandidateAuthorizer } from "../src/ai/authorizer";
import { consumeBotRateLimit } from "../src/bots/service";
import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";

const otherWorkspaceId = "00000000-0000-7000-8000-000000000002";
const memberId = "00000000-0000-7000-8000-000000000010";
const otherMemberId = "00000000-0000-7000-8000-000000000011";
const otherPageId = "00000000-0000-7000-8000-000000000020";
const restrictedParentId = "00000000-0000-7000-8000-000000000021";
const restrictedChildId = "00000000-0000-7000-8000-000000000022";
const contentHash = "a".repeat(64);

describe("cross-surface security boundaries", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM bot_rate_limits`),
      env.DB.prepare(`UPDATE pages SET parent_id = NULL`),
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

  it("requires access to every restricted ancestor before exposing search", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      userStatement(memberId, DEFAULT_WORKSPACE_ID, "member@example.com", now),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, parent_id, slug, title, body_md, revision,
            content_hash, access_mode, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, NULL, 'parent', 'Parent', 'parent secret', 1, ?3,
                 'restricted', 'active', ?4, ?5, ?5)`,
      ).bind(restrictedParentId, DEFAULT_WORKSPACE_ID, contentHash, memberId, now),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, parent_id, slug, title, body_md, revision,
            content_hash, access_mode, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'child', 'Child', 'child secret', 1, ?4,
                 'restricted', 'active', ?5, ?6, ?6)`,
      ).bind(
        restrictedChildId,
        DEFAULT_WORKSPACE_ID,
        restrictedParentId,
        contentHash,
        memberId,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO page_acl (page_id, user_id, permission, created_at, updated_at)
         VALUES (?1, ?2, 'viewer', ?3, ?3)`,
      ).bind(restrictedChildId, memberId, now),
    ]);
    const authorizer = new D1SearchCandidateAuthorizer(
      env.DB,
      "https://wiki.example",
    );
    const candidate = {
      chunkId: "child-chunk",
      key: `w/${DEFAULT_WORKSPACE_ID}/p/${restrictedChildId}.md`,
      pageId: restrictedChildId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      contentHash,
      text: "child secret",
      score: 1,
    };

    await expect(authorizer.authorize(memberId, candidate, {})).resolves.toBeNull();

    await env.DB.prepare(
      `INSERT INTO page_acl (page_id, user_id, permission, created_at, updated_at)
       VALUES (?1, ?2, 'viewer', ?3, ?3)`,
    )
      .bind(restrictedParentId, memberId, now)
      .run();
    await expect(authorizer.authorize(memberId, candidate, {})).resolves.toMatchObject({
      pageId: restrictedChildId,
    });
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
