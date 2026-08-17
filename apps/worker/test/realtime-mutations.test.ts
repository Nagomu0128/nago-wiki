import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RealtimePageMutationService,
  type RealtimeMutationEnv,
} from "../src/core/realtime-mutations";
import {
  DEFAULT_WORKSPACE_ID,
  D1WikiRepository,
} from "../src/core/repository";

const userId = "00000000-0000-7000-8000-000000000101";
const pageId = "00000000-0000-7000-8000-000000000102";
const identity: AuthenticatedIdentity = {
  id: userId,
  workspaceId: DEFAULT_WORKSPACE_ID,
  email: "editor@example.com",
  displayName: "Editor",
  role: "editor",
  status: "active",
  subject: "editor-subject",
  expiresAt: 2_000_000_000,
};

describe("RealtimePageMutationService", () => {
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
         VALUES (?1, ?2, ?3, 'Editor', 'editor', 'active', ?4, ?4)`,
      ).bind(userId, DEFAULT_WORKSPACE_ID, identity.email, now),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, parent_id, slug, title, body_md, revision,
            content_hash, access_mode, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, NULL, 'page', 'Before', 'original', 1, ?3,
                 'workspace', 'active', ?4, ?5, ?5)`,
      ).bind(pageId, DEFAULT_WORKSPACE_ID, "0".repeat(64), userId, now),
    ]);
  });

  it("preserves a just-flushed collaborative edit when saving only the title", async () => {
    const send = vi.fn(() => Promise.resolve());
    const replaceMarkdown = vi.fn(() => {
      throw new Error("title updates must not replace realtime Markdown");
    });
    const flushNow = vi.fn(async () => {
      await env.DB.prepare(
        `UPDATE pages
            SET body_md = 'collaborative edit', revision = 2,
                content_hash = ?2, updated_at = ?3
          WHERE id = ?1`,
      )
        .bind(pageId, "1".repeat(64), new Date().toISOString())
        .run();
      return { baseRevision: 2, dirty: false, nextFlushAt: null };
    });
    const environment = {
      DB: env.DB,
      FILES: env.FILES,
      ASYNC_JOBS: { send },
      PAGE_ROOM: {
        getByName: () => ({ flushNow, replaceMarkdown }),
      },
    } as unknown as RealtimeMutationEnv;
    const repository = new D1WikiRepository(env.DB);
    const original = await repository.getPage(pageId);
    if (original === null) throw new Error("test page was not created");
    const service = new RealtimePageMutationService(environment, repository);

    const updated = await service.updatePage(identity, original, {
      baseRevision: 1,
      title: "After",
    });

    expect(updated).toMatchObject({
      title: "After",
      bodyMd: "collaborative edit",
      revision: 2,
      contentHash: "1".repeat(64),
    });
    expect(flushNow).toHaveBeenCalledOnce();
    expect(replaceMarkdown).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "index-page",
        workspaceId: DEFAULT_WORKSPACE_ID,
        pageId,
        desiredHash: "1".repeat(64),
      }),
    );
  });

  it("freezes every subtree room before trash and can thaw them", async () => {
    const freezeAndFlush = vi.fn(() => Promise.resolve({
      baseRevision: 1,
      dirty: false,
      nextFlushAt: null,
    }));
    const thaw = vi.fn(() => Promise.resolve());
    const confirmTrash = vi.fn(() => Promise.resolve());
    const getByName = vi.fn(() => ({ confirmTrash, freezeAndFlush, thaw }));
    const environment = {
      DB: env.DB,
      FILES: env.FILES,
      ASYNC_JOBS: { send: vi.fn(() => Promise.resolve()) },
      PAGE_ROOM: { getByName },
    } as unknown as RealtimeMutationEnv;
    const service = new RealtimePageMutationService(
      environment,
      new D1WikiRepository(env.DB),
    );
    const childPageId = "00000000-0000-7000-8000-000000000103";

    await service.freezePagesForTrash(identity, [pageId, childPageId]);
    await service.discardPagesAfterTrash(identity, [pageId, childPageId]);
    await service.thawPages(identity, [pageId, childPageId]);

    expect(freezeAndFlush).toHaveBeenCalledTimes(2);
    expect(confirmTrash).toHaveBeenCalledTimes(2);
    expect(thaw).toHaveBeenCalledTimes(2);
    expect(getByName).toHaveBeenCalledWith(
      `${DEFAULT_WORKSPACE_ID}:${pageId}`,
    );
    expect(getByName).toHaveBeenCalledWith(
      `${DEFAULT_WORKSPACE_ID}:${childPageId}`,
    );
  });

  it("aborts trash and thaws the room when realtime edits cannot flush", async () => {
    const thaw = vi.fn(() => Promise.resolve());
    const environment = {
      DB: env.DB,
      FILES: env.FILES,
      ASYNC_JOBS: { send: vi.fn(() => Promise.resolve()) },
      PAGE_ROOM: {
        getByName: () => ({
          freezeAndFlush: () => Promise.resolve({
            baseRevision: 1,
            dirty: true,
            nextFlushAt: Date.now() + 1_000,
          }),
          thaw,
        }),
      },
    } as unknown as RealtimeMutationEnv;
    const service = new RealtimePageMutationService(
      environment,
      new D1WikiRepository(env.DB),
    );

    await expect(
      service.freezePagesForTrash(identity, [pageId]),
    ).rejects.toMatchObject({ code: "REALTIME_FLUSH_FAILED", status: 503 });
    expect(thaw).toHaveBeenCalledOnce();
  });
});
