import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { createAdminRoutes } from "../src/admin/routes";
import { AdminService } from "../src/admin/service";
import { answerBotQuery } from "../src/bots/service";
import {
  coreErrorHandler,
  coreRequestContext,
  type CoreHonoEnv,
} from "../src/core/context";
import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";
import type { McpRuntimeEnv } from "../src/mcp/types";

const ownerId = "00000000-0000-7000-8000-000000000010";
const editorId = "00000000-0000-7000-8000-000000000011";
const viewerId = "00000000-0000-7000-8000-000000000012";
const pageId = "00000000-0000-7000-8000-000000000020";
const childPageId = "00000000-0000-7000-8000-000000000021";
const otherWorkspaceId = "00000000-0000-7000-8000-000000000002";
const otherUserId = "00000000-0000-7000-8000-000000000013";

describe("owner administration", () => {
  let owner: AuthenticatedIdentity;
  let editor: AuthenticatedIdentity;
  let viewer: AuthenticatedIdentity;

  beforeEach(async () => {
    await resetDatabase();
    owner = await insertUser(ownerId, DEFAULT_WORKSPACE_ID, "owner", "owner@example.com");
    editor = await insertUser(editorId, DEFAULT_WORKSPACE_ID, "editor", "editor@example.com");
    viewer = await insertUser(viewerId, DEFAULT_WORKSPACE_ID, "viewer", "viewer@example.com");
  });

  it("updates a member with optimistic concurrency and keeps an active owner", async () => {
    const service = new AdminService(env.DB);
    const members = await service.listMembers(owner);
    const editable = members.find((member) => member.id === viewer.id);
    const ownerMember = members.find((member) => member.id === owner.id);
    expect(editable).toBeDefined();
    if (editable === undefined || ownerMember === undefined) throw new Error("expected members");

    const updated = await service.updateMember(owner, viewer.id, {
      role: "editor",
      status: "active",
      expectedUpdatedAt: editable.updatedAt,
    });
    expect(updated.role).toBe("editor");
    await expect(
      service.updateMember(owner, viewer.id, {
        role: "viewer",
        expectedUpdatedAt: editable.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "MEMBER_UPDATE_CONFLICT", status: 409 });

    await expect(
      service.updateMember(owner, owner.id, {
        status: "suspended",
        expectedUpdatedAt: ownerMember.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "LAST_ACTIVE_OWNER", status: 409 });
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1 ORDER BY created_at`,
    )
      .bind(viewer.id)
      .all<{ action: string }>();
    expect(audit.results.map((event) => event.action)).toContain("member.updated");
  });

  it("keeps an active owner when concurrent updates demote different owners", async () => {
    const secondOwner = await insertUser(
      "00000000-0000-7000-8000-000000000014",
      DEFAULT_WORKSPACE_ID,
      "owner",
      "second-owner@example.com",
    );
    const service = new AdminService(env.DB);
    const members = await service.listMembers(owner);
    const first = members.find((member) => member.id === owner.id);
    const second = members.find((member) => member.id === secondOwner.id);
    if (first === undefined || second === undefined) throw new Error("expected owners");

    const outcomes = await Promise.allSettled([
      service.updateMember(owner, owner.id, {
        role: "editor",
        expectedUpdatedAt: first.updatedAt,
      }),
      service.updateMember(owner, secondOwner.id, {
        role: "editor",
        expectedUpdatedAt: second.updatedAt,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const activeOwners = await env.DB.prepare(
      `SELECT count(*) AS count FROM users
        WHERE workspace_id = ?1 AND role = 'owner' AND status = 'active'`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<{ count: number }>();
    expect(activeOwners?.count).toBe(1);
  });

  it("replaces a restricted page ACL and hides the page from non-owners", async () => {
    await insertRestrictedPage();
    const service = new AdminService(env.DB);
    await expect(service.getPageAcl(editor, pageId)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
      status: 404,
    });

    const acl = await service.replacePageAcl(owner, pageId, {
      baseRevision: 0,
      entries: [
        { userId: editor.id, permission: "editor" },
        { userId: viewer.id, permission: "viewer" },
      ],
    });
    expect(acl).toMatchObject({ pageId, revision: 1 });
    expect(acl.entries).toHaveLength(2);
    await expect(
      service.replacePageAcl(owner, pageId, {
        baseRevision: 0,
        entries: [],
      }),
    ).rejects.toMatchObject({ code: "ACL_REVISION_CONFLICT", status: 409 });
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1`,
    )
      .bind(pageId)
      .first<{ action: string }>();
    expect(audit?.action).toBe("page_acl.replaced");
  });

  it("rejects cross-workspace ACL members without disclosing them", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Other', ?2)`,
    )
      .bind(otherWorkspaceId, now)
      .run();
    await insertUser(otherUserId, otherWorkspaceId, "viewer", "other@example.com");
    await insertRestrictedPage();

    await expect(
      new AdminService(env.DB).replacePageAcl(owner, pageId, {
        baseRevision: 0,
        entries: [{ userId: otherUserId, permission: "viewer" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
  });

  it("does not let a child ACL expand access beyond a restricted ancestor", async () => {
    await insertRestrictedPage();
    await insertRestrictedChildPage();
    const service = new AdminService(env.DB);

    await expect(
      service.replacePageAcl(owner, childPageId, {
        baseRevision: 0,
        entries: [{ userId: viewer.id, permission: "viewer" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });

    await service.replacePageAcl(owner, pageId, {
      baseRevision: 0,
      entries: [{ userId: viewer.id, permission: "viewer" }],
    });
    await expect(
      service.replacePageAcl(owner, childPageId, {
        baseRevision: 0,
        entries: [{ userId: viewer.id, permission: "viewer" }],
      }),
    ).resolves.toMatchObject({ pageId: childPageId, revision: 1 });
  });

  it("manages provider and channel controls with owner-only routes", async () => {
    const ownerApp = testApp(owner);
    const created = await ownerApp.request(
      "https://wiki.example/api/v1/admin/bot-channels",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "discord",
          externalChannelId: "channel-123",
          displayName: "Knowledge",
        }),
      },
      env,
    );
    expect(created.status).toBe(201);

    const disabled = await ownerApp.request(
      "https://wiki.example/api/v1/admin/bots/discord",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      env,
    );
    expect(disabled.status).toBe(200);
    const settings = await disabled.json<{
      providers: { provider: string; enabled: boolean; channels: { externalChannelId: string }[] }[];
    }>();
    expect(settings.providers.find((provider) => provider.provider === "discord")).toMatchObject({
      enabled: false,
      channels: [{ externalChannelId: "channel-123" }],
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO bot_events
         (provider, event_id, user_id, status, response_hash, response_text,
          created_at, updated_at)
       VALUES ('discord', 'disabled-event', NULL, 'received', NULL, NULL, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      answerBotQuery(env as McpRuntimeEnv, {
        provider: "discord",
        eventId: "disabled-event",
        externalUserId: "external-user",
        externalChannelId: null,
        query: "should not run",
      }),
    ).resolves.toBeNull();
    const ignored = await env.DB.prepare(
      `SELECT status FROM bot_events WHERE provider = 'discord' AND event_id = 'disabled-event'`,
    ).first<{ status: string }>();
    expect(ignored?.status).toBe("ignored");

    await env.DB.prepare(
      `INSERT INTO bot_events
         (provider, event_id, user_id, status, response_hash, response_text,
          created_at, updated_at)
       VALUES ('discord', 'completed-before-disable', NULL, 'completed', 'hash', 'cached', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      answerBotQuery(env as McpRuntimeEnv, {
        provider: "discord",
        eventId: "completed-before-disable",
        externalUserId: "external-user",
        externalChannelId: null,
        query: "should not replay",
      }),
    ).resolves.toBeNull();

    const forbidden = await testApp(editor).request(
      "https://wiki.example/api/v1/admin/bots",
      undefined,
      env,
    );
    expect(forbidden.status).toBe(403);
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_type IN ('bot_channel', 'bot_provider')`,
    ).all<{ action: string }>();
    expect(audit.results.map((event) => event.action)).toEqual(
      expect.arrayContaining(["bot_channel.created", "bot_provider.updated"]),
    );
  });
});

function testApp(identity: AuthenticatedIdentity): Hono<CoreHonoEnv> {
  const app = new Hono<CoreHonoEnv>();
  app.onError(coreErrorHandler);
  app.use("*", coreRequestContext);
  app.use("*", async (context, next) => {
    context.set("identity", identity);
    await next();
  });
  app.route("/api/v1", createAdminRoutes());
  return app;
}

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM page_acl_revisions;
    DELETE FROM page_acl;
    DELETE FROM audit_events;
    DELETE FROM workspace_bot_settings;
    DELETE FROM bot_channel_allowlist;
    DELETE FROM bot_events;
    DELETE FROM bot_rate_limits;
    DELETE FROM account_link_codes;
    DELETE FROM external_identities;
    UPDATE pages SET parent_id = NULL;
    DELETE FROM pages;
    DELETE FROM users;
    DELETE FROM workspaces WHERE id <> '${DEFAULT_WORKSPACE_ID}';
  `);
}

async function insertUser(
  id: string,
  workspaceId: string,
  role: "owner" | "editor" | "viewer",
  email: string,
): Promise<AuthenticatedIdentity> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users
       (id, workspace_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 'active', ?5, ?5)`,
  )
    .bind(id, workspaceId, email, role, now)
    .run();
  return {
    id,
    workspaceId,
    email,
    displayName: email,
    role,
    status: "active",
    subject: `subject:${id}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function insertRestrictedPage(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO pages
       (id, workspace_id, parent_id, slug, title, body_md, revision, content_hash,
        access_mode, status, created_by, created_at, updated_at)
     VALUES (?1, ?2, NULL, 'secret', 'Secret', 'private', 1, ?3,
             'restricted', 'active', ?4, ?5, ?5)`,
  )
    .bind(pageId, DEFAULT_WORKSPACE_ID, "a".repeat(64), ownerId, now)
    .run();
}

async function insertRestrictedChildPage(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO pages
       (id, workspace_id, parent_id, slug, title, body_md, revision, content_hash,
        access_mode, status, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'child-secret', 'Child secret', 'private', 1, ?4,
             'restricted', 'active', ?5, ?6, ?6)`,
  )
    .bind(childPageId, DEFAULT_WORKSPACE_ID, pageId, "b".repeat(64), ownerId, now)
    .run();
}
