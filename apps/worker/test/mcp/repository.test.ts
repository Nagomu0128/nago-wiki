import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";
import { McpWikiRepository } from "../../src/mcp/repository";

const userId = "00000000-0000-7000-8000-000000000010";
const contentHash = "a".repeat(64);

describe("MCP repository ACL pagination", () => {
  beforeEach(async () => {
    await env.DB.exec(`
      DELETE FROM page_links;
      DELETE FROM page_acl;
      UPDATE pages SET parent_id = NULL;
      DELETE FROM pages;
      DELETE FROM users;
    `);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'reader@example.com', 'Reader', 'viewer', 'active', ?3, ?3)`,
    )
      .bind(userId, DEFAULT_WORKSPACE_ID, now)
      .run();
  });

  it("paginates visible children after more than fifty hidden rows", async () => {
    await insertPages([
      ...hiddenPages(55),
      page("visible-1", "Z Visible one", "workspace"),
      page("visible-2", "Z Visible two", "workspace"),
    ]);
    const repository = createRepository();

    const first = await repository.listChildren(
      userId,
      DEFAULT_WORKSPACE_ID,
      null,
      null,
      1,
    );
    expect(first.pages.map((value) => value.id)).toEqual(["visible-1"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.listChildren(
      userId,
      DEFAULT_WORKSPACE_ID,
      null,
      first.nextCursor,
      1,
    );
    expect(second.pages.map((value) => value.id)).toEqual(["visible-2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns a terminal empty page when every child is hidden", async () => {
    await insertPages(hiddenPages(55));

    await expect(
      createRepository().listChildren(
        userId,
        DEFAULT_WORKSPACE_ID,
        null,
        null,
        50,
      ),
    ).resolves.toEqual({ pages: [], nextCursor: null });
  });

  it("paginates visible backlinks after more than fifty hidden sources", async () => {
    const sources = [
      ...hiddenPages(55),
      page("visible-1", "Z Visible one", "workspace"),
      page("visible-2", "Z Visible two", "workspace"),
    ];
    await insertPages([page("target", "Target", "workspace"), ...sources]);
    await insertLinks(sources.map((source) => source.id), "target");
    const repository = createRepository();

    const first = await repository.getBacklinks(
      userId,
      DEFAULT_WORKSPACE_ID,
      "target",
      null,
      1,
    );
    expect(first?.pages.map((value) => value.id)).toEqual(["visible-1"]);
    expect(first?.nextCursor).not.toBeNull();

    const second = await repository.getBacklinks(
      userId,
      DEFAULT_WORKSPACE_ID,
      "target",
      first?.nextCursor,
      1,
    );
    expect(second?.pages.map((value) => value.id)).toEqual(["visible-2"]);
    expect(second?.nextCursor).toBeNull();
  });

  it("does not reveal backlinks when the target page is restricted", async () => {
    await insertPages([
      page("restricted-target", "Restricted target", "restricted"),
      page("visible-source", "Visible source", "workspace"),
    ]);
    await insertLinks(["visible-source"], "restricted-target");

    await expect(
      createRepository().getBacklinks(
        userId,
        DEFAULT_WORKSPACE_ID,
        "restricted-target",
      ),
    ).resolves.toBeNull();
  });
});

interface TestPage {
  id: string;
  title: string;
  accessMode: "workspace" | "restricted";
}

function hiddenPages(count: number): TestPage[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = index.toString().padStart(3, "0");
    return page(`hidden-${suffix}`, `A Hidden ${suffix}`, "restricted");
  });
}

function page(
  id: string,
  title: string,
  accessMode: TestPage["accessMode"],
): TestPage {
  return { id, title, accessMode };
}

async function insertPages(pages: TestPage[]): Promise<void> {
  const now = new Date().toISOString();
  const statements = pages.map((value) =>
    env.DB.prepare(
      `INSERT INTO pages
         (id, workspace_id, parent_id, slug, title, body_md, revision,
          content_hash, access_mode, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, '', 1, ?5, ?6, 'active', ?7, ?8, ?8)`,
    ).bind(
      value.id,
      DEFAULT_WORKSPACE_ID,
      value.id,
      value.title,
      contentHash,
      value.accessMode,
      userId,
      now,
    ),
  );
  await executeBatches(statements);
}

async function insertLinks(sourceIds: string[], targetId: string): Promise<void> {
  const now = new Date().toISOString();
  const statements = sourceIds.map((sourceId) =>
    env.DB.prepare(
      `INSERT INTO page_links
         (source_page_id, target_page_id, raw_target, source_revision, created_at)
       VALUES (?1, ?2, ?3, 1, ?4)`,
    ).bind(sourceId, targetId, `/${targetId}`, now),
  );
  await executeBatches(statements);
}

async function executeBatches(statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
}

function createRepository(): McpWikiRepository {
  return new McpWikiRepository(env.DB, "https://wiki.example");
}
