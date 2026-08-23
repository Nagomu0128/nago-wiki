import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";
import { D1RealtimePermissionAuthorizer } from "../src/realtime/permission-authorizer";

const pageId = "00000000-0000-7000-8000-000000000101";
const parentId = "00000000-0000-7000-8000-000000000102";
const editorId = "00000000-0000-7000-8000-000000000201";
const viewerId = "00000000-0000-7000-8000-000000000202";

describe("realtime permission reauthorization", () => {
  beforeEach(async () => {
    await env.DB.exec(`
      DELETE FROM page_acl;
      UPDATE pages SET parent_id = NULL;
      DELETE FROM pages;
      DELETE FROM users;
    `);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
           (id, workspace_id, email, display_name, role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3, ?4, 'active', ?5, ?5)`,
      ).bind(editorId, DEFAULT_WORKSPACE_ID, "editor@example.com", "editor", now),
      env.DB.prepare(
        `INSERT INTO users
           (id, workspace_id, email, display_name, role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3, 'viewer', 'active', ?4, ?4)`,
      ).bind(viewerId, DEFAULT_WORKSPACE_ID, "viewer@example.com", now),
      pageStatement(parentId, null, "workspace", editorId, now),
      pageStatement(pageId, parentId, "workspace", editorId, now),
    ]);
  });

  it("uses the current workspace role and immediately rejects suspension", async () => {
    const authorizer = new D1RealtimePermissionAuthorizer(env.DB);
    await expect(authorizer.permission(DEFAULT_WORKSPACE_ID, pageId, editorId))
      .resolves.toBe("editor");
    await expect(authorizer.permission(DEFAULT_WORKSPACE_ID, pageId, viewerId))
      .resolves.toBe("viewer");

    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1")
      .bind(editorId)
      .run();
    await expect(authorizer.permission(DEFAULT_WORKSPACE_ID, pageId, editorId))
      .resolves.toBeNull();
  });

  it("rechecks inherited restricted ACL changes", async () => {
    const authorizer = new D1RealtimePermissionAuthorizer(env.DB);
    await env.DB.prepare("UPDATE pages SET access_mode = 'restricted' WHERE id = ?1")
      .bind(parentId)
      .run();
    await expect(authorizer.permission(DEFAULT_WORKSPACE_ID, pageId, editorId))
      .resolves.toBeNull();

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO page_acl (page_id, user_id, permission, created_at, updated_at)
       VALUES (?1, ?2, 'viewer', ?3, ?3)`,
    )
      .bind(parentId, editorId, now)
      .run();
    await expect(authorizer.permission(DEFAULT_WORKSPACE_ID, pageId, editorId))
      .resolves.toBe("viewer");
  });
});

function pageStatement(
  id: string,
  parent: string | null,
  accessMode: "workspace" | "restricted",
  creator: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO pages
       (id, workspace_id, parent_id, slug, title, body_md, revision, content_hash,
        access_mode, status, created_by, created_at, updated_at, trashed_at)
     VALUES (?1, ?2, ?3, ?1, ?1, '', 1, ?4, ?5, 'active', ?6, ?7, ?7, NULL)`,
  ).bind(id, DEFAULT_WORKSPACE_ID, parent, "0".repeat(64), accessMode, creator, now);
}
