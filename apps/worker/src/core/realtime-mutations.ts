import type {
  AuthenticatedIdentity,
  Page,
  RestoreVersionRequest,
  UpdatePageRequest,
} from "@nago-wiki/shared";

import { ApiProblem } from "./errors";
import { hashMarkdown } from "./markdown";
import {
  D1PageMutationService,
  D1WikiCoreService,
  R2VersionBodyStore,
  type PageMutationService,
} from "./page-service";
import { D1WikiRepository } from "./repository";
import { pageRoomKey } from "../realtime/types";

type RealtimeMutationEnv = Pick<Env, "DB" | "FILES" | "PAGE_ROOM">;

export class RealtimePageMutationService implements PageMutationService {
  private readonly versions: R2VersionBodyStore;

  public constructor(
    private readonly environment: RealtimeMutationEnv,
    private readonly repository: D1WikiRepository,
  ) {
    this.versions = new R2VersionBodyStore(environment.FILES);
  }

  public async updatePage(
    identity: AuthenticatedIdentity,
    page: Page,
    request: UpdatePageRequest,
  ): Promise<Page> {
    return this.replace(identity, page, request.bodyMd ?? page.bodyMd, {
      reason: "edit",
      ...(request.title === undefined ? {} : { title: request.title }),
      expectedBaseRevision: request.baseRevision,
    });
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
    const body = await this.versions.get(version.r2Key);
    if (body === null || (await hashMarkdown(body)) !== version.contentHash) {
      throw new ApiProblem(
        "VERSION_CONTENT_UNAVAILABLE",
        503,
        "Version content could not be verified",
      );
    }
    return this.replace(identity, page, body, {
      reason: "restore",
      expectedBaseRevision: request.baseRevision,
    });
  }

  private async replace(
    identity: AuthenticatedIdentity,
    page: Page,
    bodyMarkdown: string,
    options: {
      reason: "edit" | "restore";
      title?: string;
      expectedBaseRevision: number;
    },
  ): Promise<Page> {
    const room = this.environment.PAGE_ROOM.getByName(
      pageRoomKey(identity.workspaceId, page.id),
    );
    const replaced = await room.replaceMarkdown({
      workspaceId: identity.workspaceId,
      pageId: page.id,
      bodyMarkdown,
      requestedBy: identity.id,
      expectedBaseRevision: options.expectedBaseRevision,
      reason: options.reason,
    });
    if (!replaced.ok) throw revisionConflict(replaced.currentRevision);
    const status = await room.flushNow();
    if (status.dirty || status.baseRevision !== options.expectedBaseRevision + 1) {
      throw revisionConflict(status.baseRevision);
    }

    if (options.title !== undefined && options.title !== page.title) {
      const updated = await this.environment.DB.prepare(
        `UPDATE pages SET title = ?2, updated_at = ?3
          WHERE id = ?1 AND revision = ?4 AND status = 'active'`,
      )
        .bind(
          page.id,
          options.title,
          new Date().toISOString(),
          status.baseRevision,
        )
        .run();
      if (updated.meta.changes !== 1) throw revisionConflict(status.baseRevision);
    }
    const result = await this.repository.getPage(page.id);
    if (result === null) {
      throw new ApiProblem("PAGE_NOT_FOUND", 404, "Page was not found or is not visible");
    }
    return result;
  }
}

export function createRealtimeWikiCoreService(
  environment: RealtimeMutationEnv,
): D1WikiCoreService {
  const repository = new D1WikiRepository(environment.DB);
  const direct = new D1PageMutationService(
    repository,
    new R2VersionBodyStore(environment.FILES),
  );
  return new D1WikiCoreService(
    repository,
    new RealtimePageMutationService(environment, repository),
    direct,
  );
}

function revisionConflict(currentRevision: number): ApiProblem {
  return new ApiProblem(
    "REVISION_CONFLICT",
    409,
    "The page changed after the supplied base revision",
    { currentRevision },
  );
}
