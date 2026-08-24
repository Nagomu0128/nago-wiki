import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUuidV7 } from "../src/core/ids";
import {
  D1PageMutationService,
  D1WikiCoreService,
  type PageMutationService,
  type VersionBodyStore,
} from "../src/core/page-service";
import {
  DEFAULT_WORKSPACE_ID,
  D1WikiRepository,
} from "../src/core/repository";
import { TagsService } from "../src/core/tags-service";
import { refreshPageLinks } from "../src/jobs/wiki-links";

class MemoryVersionBodyStore implements VersionBodyStore {
  readonly #values = new Map<string, string>();

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.#values.get(key) ?? null);
  }

  public put(key: string, bodyMd: string): Promise<void> {
    this.#values.set(key, bodyMd);
    return Promise.resolve();
  }
}

describe("D1 wiki core", () => {
  let owner: AuthenticatedIdentity;
  let editor: AuthenticatedIdentity;
  let viewer: AuthenticatedIdentity;
  let repository: D1WikiRepository;
  let service: D1WikiCoreService;

  beforeEach(async () => {
    await resetDatabase();
    owner = await insertUser("owner", "owner@example.com");
    editor = await insertUser("editor", "editor@example.com");
    viewer = await insertUser("viewer", "viewer@example.com");
    repository = new D1WikiRepository(env.DB);
    const mutations = new D1PageMutationService(
      repository,
      new MemoryVersionBodyStore(),
    );
    service = new D1WikiCoreService(repository, mutations, mutations);
  });

  it("inherits the nearest restricted ancestor ACL", async () => {
    const restricted = await service.createPage(editor, {
      parentId: null,
      title: "Restricted",
      bodyMd: "secret",
      accessMode: "restricted",
    });
    const child = await service.createPage(editor, {
      parentId: restricted.page.id,
      title: "Child",
      bodyMd: "nested",
      accessMode: "workspace",
    });

    await expect(service.getPage(viewer, restricted.page.id)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
      status: 404,
    });
    await expect(service.getPage(viewer, child.page.id)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
      status: 404,
    });
    expect((await service.getPage(editor, child.page.id)).permission).toBe("editor");
    expect((await service.getPage(owner, child.page.id)).permission).toBe("owner");
  });

  it("does not let a child ACL expand a restricted ancestor", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Parent secret",
      bodyMd: "parent",
      accessMode: "restricted",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Child secret",
      bodyMd: "child",
      accessMode: "restricted",
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO page_acl (page_id, user_id, permission, created_at, updated_at)
       VALUES (?, ?, 'viewer', ?, ?)`,
    )
      .bind(child.page.id, viewer.id, now, now)
      .run();

    await expect(service.getPage(viewer, child.page.id)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
    expect(await service.listTree(viewer)).toEqual([]);
  });

  it("rejects stale REST updates and preserves the winning revision", async () => {
    const created = await service.createPage(editor, {
      parentId: null,
      title: "Concurrency",
      bodyMd: "one",
      accessMode: "workspace",
    });
    const updated = await service.updatePage(editor, created.page.id, {
      baseRevision: 1,
      bodyMd: "two",
    });
    expect(updated.page.revision).toBe(2);

    await expect(
      service.updatePage(editor, created.page.id, {
        baseRevision: 1,
        bodyMd: "stale",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
    expect((await service.getPage(editor, created.page.id)).page.bodyMd).toBe("two");
  });

  it("prevents cycles when moving a page", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Parent",
      bodyMd: "",
      accessMode: "workspace",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Child",
      bodyMd: "",
      accessMode: "workspace",
    });

    await expect(
      service.movePage(editor, parent.page.id, { parentId: child.page.id }),
    ).rejects.toMatchObject({ code: "INVALID_PAGE_MOVE", status: 409 });
  });

  it("atomically rejects one side of concurrent moves that would form a cycle", async () => {
    const left = await service.createPage(editor, {
      parentId: null,
      title: "Left",
      bodyMd: "",
      accessMode: "workspace",
    });
    const right = await service.createPage(editor, {
      parentId: null,
      title: "Right",
      bodyMd: "",
      accessMode: "workspace",
    });

    const results = await Promise.allSettled([
      service.movePage(editor, left.page.id, { parentId: right.page.id }),
      service.movePage(editor, right.page.id, { parentId: left.page.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await env.DB.prepare(
      "SELECT id, parent_id FROM pages WHERE id IN (?1, ?2) ORDER BY id",
    )
      .bind(left.page.id, right.page.id)
      .all<{ id: string; parent_id: string | null }>();
    expect(rows.results.every((row) => row.parent_id !== row.id)).toBe(true);
    expect(
      rows.results.every((row) => {
        const parent = rows.results.find((candidate) => candidate.id === row.parent_id);
        return parent?.parent_id !== row.id;
      }),
    ).toBe(true);
  });

  it("requires an owner to move inherited workspace content out of a restriction", async () => {
    const restricted = await service.createPage(editor, {
      parentId: null,
      title: "Restricted move",
      bodyMd: "",
      accessMode: "restricted",
    });
    const child = await service.createPage(editor, {
      parentId: restricted.page.id,
      title: "Inherited child",
      bodyMd: "",
      accessMode: "workspace",
    });

    await expect(
      service.movePage(editor, child.page.id, { parentId: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await service.movePage(owner, child.page.id, { parentId: null });
    await expect(service.getPage(viewer, child.page.id)).resolves.toMatchObject({
      page: { id: child.page.id },
    });
  });

  it("keeps old links to every descendant working after an ancestor move", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Parent",
      bodyMd: "",
      accessMode: "workspace",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Child",
      bodyMd: "",
      accessMode: "workspace",
    });
    const destination = await service.createPage(editor, {
      parentId: null,
      title: "Destination",
      bodyMd: "",
      accessMode: "workspace",
    });
    const source = await service.createPage(editor, {
      parentId: null,
      title: "Source",
      bodyMd: "[[parent/child]]",
      accessMode: "workspace",
    });

    await service.movePage(editor, parent.page.id, {
      parentId: destination.page.id,
    });
    await refreshPageLinks(env.DB, {
      workspaceId: editor.workspaceId,
      pageId: source.page.id,
      revision: source.page.revision,
      markdown: source.page.bodyMd,
    });

    const link = await env.DB.prepare(
      `SELECT target_page_id FROM page_links
        WHERE source_page_id = ? AND raw_target = ?`,
    )
      .bind(source.page.id, "parent/child")
      .first<{ target_page_id: string }>();
    expect(link?.target_page_id).toBe(child.page.id);
    const aliases = await env.DB.prepare(
      `SELECT normalized_path FROM page_aliases
        WHERE page_id IN (?, ?) ORDER BY normalized_path`,
    )
      .bind(parent.page.id, child.page.id)
      .all<{ normalized_path: string }>();
    expect(aliases.results.map((alias) => alias.normalized_path)).toEqual([
      "parent",
      "parent/child",
    ]);
  });

  it("trashes and restores an entire subtree", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Parent",
      bodyMd: "",
      accessMode: "workspace",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Child",
      bodyMd: "",
      accessMode: "workspace",
    });

    expect(await service.trashPage(editor, parent.page.id)).toEqual(
      expect.arrayContaining([parent.page.id, child.page.id]),
    );
    await expect(service.getPage(editor, child.page.id)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });

    await service.restorePage(editor, parent.page.id);
    expect((await service.getPage(editor, child.page.id)).page.status).toBe("active");
  });

  it("freezes realtime rooms before trash and thaws them after restore", async () => {
    const store = new MemoryVersionBodyStore();
    const direct = new D1PageMutationService(repository, store);
    const freezePagesForTrash = vi.fn(() => Promise.resolve());
    const discardPagesAfterTrash = vi.fn(() => Promise.resolve());
    const thawPages = vi.fn(() => Promise.resolve());
    const lifecycle: PageMutationService = {
      updatePage: direct.updatePage.bind(direct),
      restoreVersion: direct.restoreVersion.bind(direct),
      freezePagesForTrash,
      discardPagesAfterTrash,
      thawPages,
    };
    const coordinated = new D1WikiCoreService(repository, lifecycle, direct);
    const parent = await coordinated.createPage(editor, {
      parentId: null,
      title: "Coordinated parent",
      bodyMd: "parent",
      accessMode: "workspace",
    });
    const child = await coordinated.createPage(editor, {
      parentId: parent.page.id,
      title: "Coordinated child",
      bodyMd: "child",
      accessMode: "workspace",
    });

    await coordinated.trashPage(editor, parent.page.id);
    expect(freezePagesForTrash).toHaveBeenCalledWith(
      editor,
      expect.arrayContaining([parent.page.id, child.page.id]),
    );
    expect(discardPagesAfterTrash).toHaveBeenCalledWith(
      editor,
      expect.arrayContaining([parent.page.id, child.page.id]),
    );

    await coordinated.restorePage(editor, parent.page.id);
    expect(thawPages).toHaveBeenCalledWith(
      editor,
      expect.arrayContaining([parent.page.id, child.page.id]),
    );
  });

  it("does not restore a child trashed by an earlier operation", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Parent",
      bodyMd: "",
      accessMode: "workspace",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Child",
      bodyMd: "",
      accessMode: "workspace",
    });

    await service.trashPage(editor, child.page.id);
    await service.trashPage(editor, parent.page.id);
    await service.restorePage(editor, parent.page.id);

    await expect(service.getPage(editor, child.page.id)).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
    await service.restorePage(editor, child.page.id);
    expect((await service.getPage(editor, child.page.id)).page.status).toBe("active");
  });

  it("restores to root when the original parent is unavailable", async () => {
    const parent = await service.createPage(editor, {
      parentId: null,
      title: "Unavailable parent",
      bodyMd: "",
      accessMode: "workspace",
    });
    const child = await service.createPage(editor, {
      parentId: parent.page.id,
      title: "Detached child",
      bodyMd: "",
      accessMode: "workspace",
    });
    await service.trashPage(editor, child.page.id);
    await service.trashPage(editor, parent.page.id);

    await expect(service.restorePage(editor, child.page.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    const restored = await service.restorePage(owner, child.page.id);

    expect(restored.page.parentId).toBeNull();
    expect(restored.page.slug).toBe("detached-child");
  });

  it("appends the restoration date when the destination slug is occupied", async () => {
    const original = await service.createPage(editor, {
      parentId: null,
      title: "Collision",
      bodyMd: "old",
      accessMode: "workspace",
    });
    await service.trashPage(editor, original.page.id);
    await service.createPage(editor, {
      parentId: null,
      title: "Collision",
      bodyMd: "new",
      accessMode: "workspace",
    });

    const restored = await service.restorePage(editor, original.page.id);

    expect(restored.page.parentId).toBeNull();
    expect(restored.page.slug).toMatch(
      /^collision-restored-\d{4}-\d{2}-\d{2}-/u,
    );
  });

  it("restores immutable version content as a new revision", async () => {
    const created = await service.createPage(editor, {
      parentId: null,
      title: "History",
      bodyMd: "original",
      accessMode: "workspace",
    });
    await service.updatePage(editor, created.page.id, {
      baseRevision: 1,
      bodyMd: "changed",
    });
    const versions = await service.listVersions(editor, created.page.id);
    const original = versions.find((version) => version.revision === 1);
    expect(original).toBeDefined();
    if (original === undefined) throw new Error("expected original version");

    const restored = await service.restoreVersion(
      editor,
      created.page.id,
      original.id,
      { baseRevision: 2 },
    );
    expect(restored.page).toMatchObject({ bodyMd: "original", revision: 3 });
  });

  it("keeps restricted titles out of another user's tree", async () => {
    await service.createPage(editor, {
      parentId: null,
      title: "Visible",
      bodyMd: "",
      accessMode: "workspace",
    });
    await service.createPage(editor, {
      parentId: null,
      title: "Hidden",
      bodyMd: "",
      accessMode: "restricted",
    });

    const tree = await service.listTree(viewer);
    expect(tree.map((page) => page.title)).toEqual(["Visible"]);
  });

  it("stores comments and validated mentions", async () => {
    const page = await service.createPage(editor, {
      parentId: null,
      title: "Discussion",
      bodyMd: "",
      accessMode: "workspace",
    });
    const comment = await service.createComment(viewer, page.page.id, {
      bodyMd: "Hello @editor",
      mentionedUserIds: [editor.id],
    });
    expect(comment.mentionedUserIds).toEqual([editor.id]);
    expect(await service.listComments(viewer, page.page.id)).toHaveLength(1);
  });

  it("keeps tags on restricted pages out of unauthorized tag lists", async () => {
    const page = await service.createPage(editor, {
      parentId: null,
      title: "Tagged secret",
      bodyMd: "",
      accessMode: "restricted",
    });
    const tags = new TagsService(env.DB);
    await expect(
      tags.replacePageTags(editor, page.page.id, ["Cloudflare", "AI"]),
    ).resolves.toHaveLength(2);

    await expect(tags.listVisible(viewer)).resolves.toEqual([]);
    await expect(tags.listVisible(owner)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "AI" }),
        expect.objectContaining({ name: "Cloudflare" }),
      ]),
    );
  });

  it("provisions a verified Access identity once as a viewer", async () => {
    const claims = {
      aud: "audience",
      email: "new-member@example.com",
      exp: 2_000_000_000,
      iss: "https://team.cloudflareaccess.com",
      name: "New Member",
      sub: "new-member-subject",
    };
    const first = await repository.resolveAccessIdentity(claims);
    const second = await repository.resolveAccessIdentity(claims);

    expect(first).toMatchObject({ role: "viewer", status: "active" });
    expect(second.id).toBe(first.id);
    const identityCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM external_identities WHERE external_subject = ?",
    )
      .bind(claims.sub)
      .first<{ count: number }>();
    expect(identityCount?.count).toBe(1);
  });

  it("replays page creation idempotently and rejects key reuse", async () => {
    const request = {
      parentId: null,
      title: "Idempotent",
      bodyMd: "same request",
      accessMode: "workspace" as const,
    };
    const first = await service.createPage(editor, request, "request-key");
    const replay = await service.createPage(editor, request, "request-key");
    expect(replay.page.id).toBe(first.page.id);

    await expect(
      service.createPage(
        editor,
        { ...request, bodyMd: "different request" },
        "request-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("reserves a stable page ID for retryable imports", async () => {
    const request = {
      parentId: null,
      title: "Imported page",
      bodyMd: "![image](/api/v1/pages/reserved/assets/image)",
      accessMode: "workspace" as const,
    };
    const pageId = createUuidV7();
    const created = await service.createPageWithId(
      editor,
      pageId,
      request,
      "import:one",
    );
    const replay = await service.createPageWithId(
      editor,
      pageId,
      request,
      "import:one",
    );

    expect(created.page.id).toBe(pageId);
    expect(replay.page.id).toBe(pageId);
    await expect(service.createPageWithId(
      editor,
      createUuidV7(),
      request,
      "import:one",
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
});

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM mentions;
    DELETE FROM comments;
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
    DELETE FROM imports;
    DELETE FROM bot_channel_allowlist;
    DELETE FROM bot_events;
    DELETE FROM bot_rate_limits;
    DELETE FROM account_link_codes;
    DELETE FROM chat_audit;
    DELETE FROM audit_events;
    DELETE FROM users;
  `);
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
