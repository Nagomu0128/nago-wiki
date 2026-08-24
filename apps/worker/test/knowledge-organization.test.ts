import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import {
  coreErrorHandler,
  type CoreHonoEnv,
} from "../src/core/context";
import { KnowledgeOrganizationService } from "../src/core/knowledge-organization-service";
import { createUuidV7 } from "../src/core/ids";
import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";
import { createOrganizationRoutes } from "../src/routes/organization";

describe("knowledge organization", () => {
  let editor: AuthenticatedIdentity;
  let viewer: AuthenticatedIdentity;
  let service: KnowledgeOrganizationService;

  beforeEach(async () => {
    await resetDatabase();
    editor = await insertUser("editor", "editor-organize@example.com");
    viewer = await insertUser("viewer", "viewer-organize@example.com");
    service = new KnowledgeOrganizationService(env.DB);
  });

  it("records only authorized active pages in recent and favorites", async () => {
    const visiblePageId = await insertPage(editor.id, {
      title: "Visible knowledge",
      slug: "visible-knowledge",
    });
    const hiddenPageId = await insertPage(editor.id, {
      title: "Hidden knowledge",
      slug: "hidden-knowledge",
      accessMode: "restricted",
    });

    await service.recordPageView(viewer, visiblePageId);
    await service.setFavorite(viewer, visiblePageId, true);
    await expect(service.recordPageView(viewer, hiddenPageId)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
      status: 404,
    });

    await expect(service.listRecent(viewer)).resolves.toEqual([
      expect.objectContaining({ id: visiblePageId, title: "Visible knowledge" }),
    ]);
    await expect(service.listFavorites(viewer)).resolves.toEqual([
      expect.objectContaining({ id: visiblePageId, title: "Visible knowledge" }),
    ]);

    await service.setFavorite(viewer, visiblePageId, false);
    await expect(service.listFavorites(viewer)).resolves.toEqual([]);
    await expect(service.listRecent(viewer)).resolves.toHaveLength(1);
  });

  it("removes a favorite that has no view history without violating state constraints", async () => {
    const pageId = await insertPage(editor.id, {
      title: "Favorite only",
      slug: "favorite-only",
    });

    await service.setFavorite(viewer, pageId, true);
    await expect(service.setFavorite(viewer, pageId, false)).resolves.toBeUndefined();
    await expect(service.listFavorites(viewer)).resolves.toEqual([]);

    const state = await env.DB.prepare(
      "SELECT page_id FROM user_page_state WHERE user_id = ? AND page_id = ?",
    )
      .bind(viewer.id, pageId)
      .first<{ page_id: string }>();
    expect(state).toBeNull();
  });

  it("omits trashed descendants from the trash root list and marks dependencies", async () => {
    const parentId = await insertPage(editor.id, {
      title: "Trashed root",
      slug: "trashed-root",
      status: "trashed",
      trashBatchId: "batch-parent",
    });
    await insertPage(editor.id, {
      parentId,
      title: "Same batch child",
      slug: "same-batch-child",
      status: "trashed",
      trashBatchId: "batch-parent",
    });
    const earlierChildId = await insertPage(editor.id, {
      parentId,
      title: "Earlier child",
      slug: "earlier-child",
      status: "trashed",
      trashBatchId: "batch-earlier",
    });
    await insertPage(editor.id, {
      title: "Private trash",
      slug: "private-trash",
      accessMode: "restricted",
      status: "trashed",
      trashBatchId: "batch-private",
    });

    const trash = await service.listTrash(viewer);

    expect(trash.map((page) => page.id)).toEqual(
      expect.arrayContaining([parentId, earlierChildId]),
    );
    expect(trash).toHaveLength(2);
    expect(trash.find((page) => page.id === parentId)?.restorable).toBe(true);
    expect(trash.find((page) => page.id === earlierChildId)?.restorable).toBe(false);
  });

  it("removes trashed pages from navigation collections without deleting state", async () => {
    const pageId = await insertPage(editor.id, {
      title: "Remembered",
      slug: "remembered",
    });
    await service.recordPageView(viewer, pageId);
    await service.setFavorite(viewer, pageId, true);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE pages
          SET status = 'trashed', trashed_at = ?, trash_batch_id = ?
        WHERE id = ?`,
    )
      .bind(now, "batch-remembered", pageId)
      .run();

    await expect(service.listRecent(viewer)).resolves.toEqual([]);
    await expect(service.listFavorites(viewer)).resolves.toEqual([]);

    await env.DB.prepare(
      `UPDATE pages
          SET status = 'active', trashed_at = NULL, trash_batch_id = NULL
        WHERE id = ?`,
    )
      .bind(pageId)
      .run();
    await expect(service.listFavorites(viewer)).resolves.toHaveLength(1);
  });

  it("applies authorization before limiting recent, favorite, and trash results", async () => {
    const visiblePageId = await insertPage(editor.id, {
      title: "Visible after hidden candidates",
      slug: "visible-after-hidden-candidates",
    });
    const hiddenTimestamp = new Date().toISOString();
    const visibleTimestamp = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 201
       )
       INSERT INTO pages
         (id, workspace_id, parent_id, slug, title, body_md, revision,
          content_hash, access_mode, status, created_by, created_at, updated_at,
          trashed_at, trash_batch_id)
       SELECT printf('hidden-padding-%03d', value), ?, NULL,
              printf('hidden-padding-%03d', value), 'Hidden padding', '', 1, ?,
              'restricted', 'active', ?, ?, ?, NULL, NULL
         FROM sequence`,
    )
      .bind(
        DEFAULT_WORKSPACE_ID,
        "0".repeat(64),
        editor.id,
        hiddenTimestamp,
        hiddenTimestamp,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO user_page_state
         (user_id, page_id, favorited_at, last_viewed_at)
       SELECT ?, id, ?, ? FROM pages WHERE id LIKE 'hidden-padding-%'
       UNION ALL SELECT ?, ?, ?, ?`,
    )
      .bind(
        viewer.id,
        hiddenTimestamp,
        hiddenTimestamp,
        viewer.id,
        visiblePageId,
        visibleTimestamp,
        visibleTimestamp,
      )
      .run();

    await expect(service.listRecent(viewer)).resolves.toEqual([
      expect.objectContaining({ id: visiblePageId }),
    ]);
    await expect(service.listFavorites(viewer)).resolves.toEqual([
      expect.objectContaining({ id: visiblePageId }),
    ]);

    await env.DB.prepare(
      `UPDATE pages
          SET status = 'trashed', trashed_at = ?, trash_batch_id = 'hidden-batch'
        WHERE id LIKE 'hidden-padding-%'`,
    )
      .bind(hiddenTimestamp)
      .run();
    await env.DB.prepare(
      `UPDATE pages
          SET status = 'trashed', trashed_at = ?, trash_batch_id = 'visible-batch'
        WHERE id = ?`,
    )
      .bind(visibleTimestamp, visiblePageId)
      .run();

    await expect(service.listTrash(viewer)).resolves.toEqual([
      expect.objectContaining({ id: visiblePageId }),
    ]);
  });

  it("rejects oversized tag replacement bodies before parsing JSON", async () => {
    const app = new Hono<CoreHonoEnv>();
    app.onError(coreErrorHandler);
    app.use("*", async (context, next) => {
      context.set("identity", editor);
      await next();
    });
    app.route("/api/v1", createOrganizationRoutes());

    const response = await app.request(
      `https://wiki.example/api/v1/pages/${createUuidV7()}/tags`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: ["x".repeat(17_000)] }),
      },
      env,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });
});

interface InsertPageOptions {
  parentId?: string | null;
  title: string;
  slug: string;
  accessMode?: "workspace" | "restricted";
  status?: "active" | "trashed";
  trashBatchId?: string;
}

async function insertPage(
  createdBy: string,
  options: InsertPageOptions,
): Promise<string> {
  const id = createUuidV7();
  const now = new Date().toISOString();
  const status = options.status ?? "active";
  await env.DB.prepare(
    `INSERT INTO pages
       (id, workspace_id, parent_id, slug, title, body_md, revision,
        content_hash, access_mode, status, created_by, created_at, updated_at,
        trashed_at, trash_batch_id)
     VALUES (?, ?, ?, ?, ?, '', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      DEFAULT_WORKSPACE_ID,
      options.parentId ?? null,
      options.slug,
      options.title,
      "0".repeat(64),
      options.accessMode ?? "workspace",
      status,
      createdBy,
      now,
      now,
      status === "trashed" ? now : null,
      status === "trashed" ? options.trashBatchId : null,
    )
    .run();
  return id;
}

async function insertUser(
  role: AuthenticatedIdentity["role"],
  email: string,
): Promise<AuthenticatedIdentity> {
  const id = createUuidV7();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users
       (id, workspace_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, DEFAULT_WORKSPACE_ID, email, email, role, now, now)
    .run();
  return {
    id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    email,
    displayName: email,
    role,
    status: "active",
    subject: `subject:${email}`,
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
}

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM user_page_state;
    DELETE FROM page_version_outbox;
    DELETE FROM page_versions;
    DELETE FROM page_tags;
    DELETE FROM page_links;
    DELETE FROM page_aliases;
    DELETE FROM page_acl;
    DELETE FROM index_state;
    DELETE FROM page_create_idempotency;
    UPDATE pages SET parent_id = NULL;
    DELETE FROM pages;
    DELETE FROM tags;
    DELETE FROM external_identities;
    DELETE FROM users;
  `);
}
