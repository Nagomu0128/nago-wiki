import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";
import { indexPage } from "../src/jobs/index-page";
import { reconcilePendingJobs } from "../src/jobs/reconcile";
import type { McpRuntimeEnv } from "../src/mcp/types";

const userId = "00000000-0000-7000-8000-000000000201";
const pageId = "00000000-0000-7000-8000-000000000202";
const contentHash = "2".repeat(64);

describe("AI Search deletion", () => {
  beforeEach(async () => {
    await env.DB.exec(`
      DELETE FROM page_version_outbox;
      DELETE FROM page_versions;
      DELETE FROM index_state;
      UPDATE pages SET parent_id = NULL;
      DELETE FROM pages;
      DELETE FROM users;
    `);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
           (id, workspace_id, email, display_name, role, status, created_at, updated_at)
         VALUES (?1, ?2, 'editor@example.com', 'Editor', 'editor', 'active', ?3, ?3)`,
      ).bind(userId, DEFAULT_WORKSPACE_ID, now),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, slug, title, body_md, revision, content_hash,
            access_mode, status, created_by, created_at, updated_at,
            trashed_at, trash_batch_id)
         VALUES (?1, ?2, 'trashed', 'Trashed', 'body', 1, ?3,
                 'workspace', 'trashed', ?4, ?5, ?5, ?5, 'trash-batch')`,
      ).bind(pageId, DEFAULT_WORKSPACE_ID, contentHash, userId, now),
      env.DB.prepare(
        `INSERT INTO index_state
           (page_id, desired_hash, indexed_hash, status, last_error, updated_at)
         VALUES (?1, ?2, ?2, 'deleted', NULL, ?3)`,
      ).bind(pageId, contentHash, now),
    ]);
  });

  it("physically removes a trashed item and records completion", async () => {
    const remove = vi.fn(() => Promise.resolve());
    const search = {
      items: { delete: remove },
    } as unknown as AiSearchInstance;

    await expect(
      indexPage(
        { database: env.DB, search },
        {
          type: "index-page",
          jobId: crypto.randomUUID(),
          workspaceId: DEFAULT_WORKSPACE_ID,
          pageId,
          desiredHash: contentHash,
        },
      ),
    ).resolves.toBe("deleted");

    expect(remove).toHaveBeenCalledWith(
      `w/${DEFAULT_WORKSPACE_ID}/p/${pageId}.md`,
    );
    await expect(
      env.DB.prepare(
        "SELECT status, indexed_hash FROM index_state WHERE page_id = ?1",
      )
        .bind(pageId)
        .first(),
    ).resolves.toMatchObject({ status: "deleted", indexed_hash: null });
  });

  it("keeps a concurrent restore pending after the stale delete finishes", async () => {
    const remove = vi.fn(async () => {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE pages SET status = 'active', trashed_at = NULL,
              trash_batch_id = NULL WHERE id = ?1`,
        ).bind(pageId),
        env.DB.prepare(
          `UPDATE index_state SET status = 'pending', indexed_hash = NULL
            WHERE page_id = ?1`,
        ).bind(pageId),
      ]);
    });
    const search = {
      items: { delete: remove },
    } as unknown as AiSearchInstance;

    await indexPage(
      { database: env.DB, search },
      {
        type: "index-page",
        jobId: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        pageId,
        desiredHash: contentHash,
      },
    );

    await expect(
      env.DB.prepare("SELECT status FROM index_state WHERE page_id = ?1")
        .bind(pageId)
        .first(),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("reconciles trashed items until their physical deletion is confirmed", async () => {
    const sendBatch = vi.fn((messages: MessageSendRequest[]) => {
      void messages;
      return Promise.resolve();
    });
    await reconcilePendingJobs({
      DB: env.DB,
      ASYNC_JOBS: { sendBatch },
    } as unknown as McpRuntimeEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch.mock.calls[0]?.[0]?.[0]?.body).toMatchObject({
      type: "index-page",
      workspaceId: DEFAULT_WORKSPACE_ID,
      pageId,
      desiredHash: contentHash,
    });
  });
});
