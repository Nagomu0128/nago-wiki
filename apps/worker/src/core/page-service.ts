import type {
  AuthenticatedIdentity,
  Comment,
  CreateCommentRequest,
  CreatePageRequest,
  MovePageRequest,
  Page,
  PageTreeNode,
  PageVersion,
  PageWithPermission,
  RestoreVersionRequest,
  UpdatePageRequest,
} from "@nago-wiki/shared";
import { AuthorizationService, canEdit, canView } from "./authorization";
import { ApiProblem } from "./errors";
import { createUuidV7 } from "./ids";
import { assertMarkdownSize, hashMarkdown, normalizeSlug } from "./markdown";
import {
  D1WikiRepository,
  pageNotFound,
  type PageVersionStorageRecord,
} from "./repository";

export interface PageMutationService {
  updatePage(
    identity: AuthenticatedIdentity,
    page: Page,
    request: UpdatePageRequest,
  ): Promise<Page>;
  restoreVersion(
    identity: AuthenticatedIdentity,
    page: Page,
    versionId: string,
    request: RestoreVersionRequest,
  ): Promise<Page>;
}

export interface WikiCoreService {
  getPage(identity: AuthenticatedIdentity, pageId: string): Promise<PageWithPermission>;
  createPage(
    identity: AuthenticatedIdentity,
    request: CreatePageRequest,
    idempotencyKey?: string,
  ): Promise<PageWithPermission>;
  updatePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: UpdatePageRequest,
  ): Promise<PageWithPermission>;
  movePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: MovePageRequest,
  ): Promise<PageWithPermission>;
  trashPage(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<string[]>;
  restorePage(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageWithPermission>;
  listTree(identity: AuthenticatedIdentity): Promise<PageTreeNode[]>;
  listVersions(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageVersion[]>;
  restoreVersion(
    identity: AuthenticatedIdentity,
    pageId: string,
    versionId: string,
    request: RestoreVersionRequest,
  ): Promise<PageWithPermission>;
  listComments(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<Comment[]>;
  createComment(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: CreateCommentRequest,
  ): Promise<Comment>;
}

export interface VersionBodyStore {
  get(key: string): Promise<string | null>;
  put(key: string, bodyMd: string): Promise<void>;
}

export class R2VersionBodyStore implements VersionBodyStore {
  public constructor(private readonly bucket: R2Bucket) {}

  public async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    if (object.size > 1_048_576) return null;
    return object.text();
  }

  public async put(key: string, bodyMd: string): Promise<void> {
    await this.bucket.put(key, bodyMd, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  }
}

export class D1PageMutationService implements PageMutationService {
  public constructor(
    private readonly repository: D1WikiRepository,
    private readonly versionStore: VersionBodyStore,
  ) {}

  public async updatePage(
    identity: AuthenticatedIdentity,
    page: Page,
    request: UpdatePageRequest,
  ): Promise<Page> {
    const bodyMd = request.bodyMd ?? page.bodyMd;
    assertPageBodySize(bodyMd);
    const mutation = await this.repository.mutatePage({
      pageId: page.id,
      baseRevision: request.baseRevision,
      parentId: page.parentId,
      slug: page.slug,
      title: request.title ?? page.title,
      bodyMd,
      contentHash: await hashMarkdown(bodyMd),
      authorId: identity.id,
      reason: "edit",
    });
    await this.persistVersion(mutation.version, bodyMd);
    return mutation.page;
  }

  public async restoreVersion(
    identity: AuthenticatedIdentity,
    page: Page,
    versionId: string,
    request: RestoreVersionRequest,
  ): Promise<Page> {
    const version = await this.repository.getVersion(page.id, versionId);
    if (version === null) {
      throw new ApiProblem("VERSION_NOT_FOUND", 404, "Version was not found");
    }
    if (version.storageStatus !== "ready") {
      throw new ApiProblem(
        "VERSION_CONTENT_UNAVAILABLE",
        503,
        "Version content is not available yet",
      );
    }
    const bodyMd = await this.versionStore.get(version.r2Key);
    if (bodyMd === null || (await hashMarkdown(bodyMd)) !== version.contentHash) {
      throw new ApiProblem(
        "VERSION_CONTENT_UNAVAILABLE",
        503,
        "Version content could not be verified",
      );
    }
    const mutation = await this.repository.mutatePage({
      pageId: page.id,
      baseRevision: request.baseRevision,
      parentId: page.parentId,
      slug: page.slug,
      title: page.title,
      bodyMd,
      contentHash: version.contentHash,
      authorId: identity.id,
      reason: "restore",
    });
    await this.persistVersion(mutation.version, bodyMd);
    return mutation.page;
  }

  public async persistVersion(
    version: PageVersionStorageRecord,
    bodyMd: string,
  ): Promise<void> {
    try {
      await this.versionStore.put(version.r2Key, bodyMd);
      await this.repository.markVersionStored(version.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.markVersionStorageFailed(version.id, message);
      console.error(
        JSON.stringify({
          message: "page version storage failed",
          pageId: version.pageId,
          versionId: version.id,
          error: message,
        }),
      );
    }
  }
}

export class D1WikiCoreService implements WikiCoreService {
  readonly #authorization: AuthorizationService;

  public constructor(
    private readonly repository: D1WikiRepository,
    private readonly mutations: PageMutationService,
    private readonly directMutations?: D1PageMutationService,
  ) {
    this.#authorization = new AuthorizationService(repository);
  }

  public async getPage(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageWithPermission> {
    const page = await this.requirePage(identity, pageId, false, false);
    return this.toPageResponse(identity, page);
  }

  public async createPage(
    identity: AuthenticatedIdentity,
    request: CreatePageRequest,
    idempotencyKey?: string,
  ): Promise<PageWithPermission> {
    assertWorkspaceEditor(identity);
    if (request.parentId !== null) {
      await this.requirePage(identity, request.parentId, true, false);
    }
    assertPageBodySize(request.bodyMd);
    const slug = normalizeSlug(request.slug ?? request.title);
    let idempotency:
      | {
          userId: string;
          keyHash: string;
          requestHash: string;
          expiresAt: string;
        }
      | undefined;
    if (idempotencyKey !== undefined) {
      const keyHash = await hashMarkdown(idempotencyKey);
      const requestHash = await hashMarkdown(
        JSON.stringify([
          request.parentId,
          slug,
          request.title,
          request.bodyMd,
          request.accessMode,
        ]),
      );
      const existing = await this.repository.getPageCreationIdempotency(
        identity.id,
        keyHash,
      );
      const currentTime = new Date().toISOString();
      if (existing !== null && existing.expiresAt > currentTime) {
        if (existing.requestHash !== requestHash) {
          throw idempotencyConflict();
        }
        const existingPage = await this.repository.getPage(existing.pageId);
        if (existingPage === null) throw idempotencyConflict();
        return this.toPageResponse(identity, existingPage);
      }
      if (existing !== null) {
        await this.repository.deleteExpiredPageCreationIdempotency(
          identity.id,
          keyHash,
          currentTime,
        );
      }
      idempotency = {
        userId: identity.id,
        keyHash,
        requestHash,
        // Import application retries must survive for the complete preview
        // lifetime: a lost response happens after the page transaction.
        expiresAt: new Date(
          Date.now() +
            (idempotencyKey.startsWith("import:") ? 8 * 86_400_000 : 86_400_000),
        ).toISOString(),
      };
    }
    const now = new Date().toISOString();
    const pageId = createUuidV7();
    const contentHash = await hashMarkdown(request.bodyMd);
    const page: Page = {
      id: pageId,
      workspaceId: identity.workspaceId,
      parentId: request.parentId,
      slug,
      title: request.title,
      bodyMd: request.bodyMd,
      revision: 1,
      contentHash,
      accessMode: request.accessMode,
      status: "active",
      createdBy: identity.id,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
    };
    const version: PageVersionStorageRecord = {
      id: createUuidV7(),
      pageId,
      revision: 1,
      r2Key: `versions/${identity.workspaceId}/${pageId}/1.md`,
      contentHash,
      authorId: identity.id,
      reason: "create",
      storageStatus: "pending",
      createdAt: now,
    };
    try {
      await this.repository.createPage(
        page,
        version,
        request.accessMode === "restricted" && identity.role !== "owner"
          ? "editor"
          : null,
        idempotency,
      );
    } catch (error) {
      if (
        error instanceof ApiProblem &&
        error.code === "IDEMPOTENCY_CONFLICT" &&
        idempotency !== undefined
      ) {
        const existing = await this.repository.getPageCreationIdempotency(
          identity.id,
          idempotency.keyHash,
        );
        if (existing?.requestHash === idempotency.requestHash) {
          const existingPage = await this.repository.getPage(existing.pageId);
          if (existingPage !== null) return this.toPageResponse(identity, existingPage);
        }
      }
      throw error;
    }
    if (this.directMutations !== undefined) {
      await this.directMutations.persistVersion(version, request.bodyMd);
    }
    return this.toPageResponse(identity, page);
  }

  public async updatePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: UpdatePageRequest,
  ): Promise<PageWithPermission> {
    const page = await this.requirePage(identity, pageId, true, false);
    const updated = await this.mutations.updatePage(identity, page, request);
    return this.toPageResponse(identity, updated);
  }

  public async movePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: MovePageRequest,
  ): Promise<PageWithPermission> {
    const page = await this.requirePage(identity, pageId, true, false);
    if (request.parentId !== null) {
      await this.requirePage(identity, request.parentId, true, false);
      if (await this.repository.isPageInSubtree(page.id, request.parentId)) {
        throw new ApiProblem(
          "INVALID_PAGE_MOVE",
          409,
          "A page cannot be moved into its own subtree",
        );
      }
    }
    const previousPath = await this.repository.getPagePath(page.id);
    const mutation = await this.repository.mutatePage({
      pageId: page.id,
      baseRevision: page.revision,
      parentId: request.parentId,
      slug: normalizeSlug(request.slug ?? page.slug),
      title: request.title ?? page.title,
      bodyMd: page.bodyMd,
      contentHash: page.contentHash,
      authorId: identity.id,
      reason: "move",
      previousPath,
    });
    if (this.directMutations !== undefined) {
      await this.directMutations.persistVersion(mutation.version, page.bodyMd);
    }
    return this.toPageResponse(identity, mutation.page);
  }

  public async trashPage(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<string[]> {
    await this.requirePage(identity, pageId, true, false);
    const pageIds = await this.repository.trashSubtree(pageId);
    if (pageIds.length === 0) throw pageNotFound();
    return pageIds;
  }

  public async restorePage(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageWithPermission> {
    const page = await this.requirePage(identity, pageId, true, true);
    if (page.status !== "trashed") throw pageNotFound();
    if (page.parentId !== null) {
      const parent = await this.repository.getPage(page.parentId);
      if (parent?.status !== "active") {
        throw new ApiProblem(
          "INVALID_PAGE_MOVE",
          409,
          "Restore the parent page first",
        );
      }
    }
    const restoredIds = await this.repository.restoreSubtree(pageId);
    if (restoredIds.length === 0) throw pageNotFound();
    const restored = await this.repository.getPage(pageId);
    if (restored === null) throw pageNotFound();
    return this.toPageResponse(identity, restored);
  }

  public async listTree(
    identity: AuthenticatedIdentity,
  ): Promise<PageTreeNode[]> {
    if (identity.status !== "active") {
      throw new ApiProblem("FORBIDDEN", 403, "This account is suspended");
    }
    return this.repository.listVisiblePageTree(identity);
  }

  public async listVersions(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageVersion[]> {
    await this.requirePage(identity, pageId, false, false);
    return this.repository.listVersions(pageId);
  }

  public async restoreVersion(
    identity: AuthenticatedIdentity,
    pageId: string,
    versionId: string,
    request: RestoreVersionRequest,
  ): Promise<PageWithPermission> {
    const page = await this.requirePage(identity, pageId, true, false);
    const restored = await this.mutations.restoreVersion(
      identity,
      page,
      versionId,
      request,
    );
    return this.toPageResponse(identity, restored);
  }

  public async listComments(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<Comment[]> {
    await this.requirePage(identity, pageId, false, false);
    return this.repository.listComments(pageId);
  }

  public async createComment(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: CreateCommentRequest,
  ): Promise<Comment> {
    await this.requirePage(identity, pageId, false, false);
    if (new TextEncoder().encode(request.bodyMd).byteLength > 65_536) {
      throw new ApiProblem(
        "PAYLOAD_TOO_LARGE",
        413,
        "Comment Markdown must not exceed 64 KiB",
      );
    }
    return this.repository.createComment(
      pageId,
      identity.id,
      identity.workspaceId,
      request.bodyMd,
      request.mentionedUserIds,
    );
  }

  private async requirePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    write: boolean,
    includeTrashed: boolean,
  ): Promise<Page> {
    const page = await this.repository.getPage(pageId);
    if (
      page?.workspaceId !== identity.workspaceId ||
      (!includeTrashed && page.status !== "active")
    ) {
      throw pageNotFound();
    }
    const permission = await this.#authorization.effectivePermission(identity, pageId);
    if (!canView(permission)) throw pageNotFound();
    if (write && !canEdit(permission)) {
      throw new ApiProblem("FORBIDDEN", 403, "Editor permission is required");
    }
    return page;
  }

  private async toPageResponse(
    identity: AuthenticatedIdentity,
    page: Page,
  ): Promise<PageWithPermission> {
    const permission = await this.#authorization.effectivePermission(identity, page.id);
    if (permission === "none") throw pageNotFound();
    return {
      page,
      permission,
      tags: await this.repository.getTagsForPage(page.id),
    };
  }
}

export function createD1WikiCoreService(environment: Env): D1WikiCoreService {
  const repository = new D1WikiRepository(environment.DB);
  const directMutations = new D1PageMutationService(
    repository,
    new R2VersionBodyStore(environment.FILES),
  );
  return new D1WikiCoreService(repository, directMutations, directMutations);
}

function assertWorkspaceEditor(identity: AuthenticatedIdentity): void {
  if (identity.status !== "active" || identity.role === "viewer") {
    throw new ApiProblem("FORBIDDEN", 403, "Editor permission is required");
  }
}

function assertPageBodySize(bodyMd: string): void {
  try {
    assertMarkdownSize(bodyMd);
  } catch {
    throw new ApiProblem(
      "PAYLOAD_TOO_LARGE",
      413,
      "Page Markdown must not exceed 1 MiB",
    );
  }
}

function idempotencyConflict(): ApiProblem {
  return new ApiProblem(
    "IDEMPOTENCY_CONFLICT",
    409,
    "This idempotency key was used with a different request",
  );
}
