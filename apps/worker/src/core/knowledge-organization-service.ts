import type {
  AuthenticatedIdentity,
  FavoritePageItem,
  Page,
  PageNavigationItem,
  RecentPageItem,
  TrashedPageItem,
} from "@nago-wiki/shared";

import { AuthorizationService, canView } from "./authorization";
import { ApiProblem } from "./errors";
import { D1WikiRepository } from "./repository";

const COLLECTION_LIMIT = 50;
const CANDIDATE_LIMIT = 200;
const TRASH_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

interface NavigationRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  access_mode: "workspace" | "restricted";
  updated_at: string;
}

interface RecentRow extends NavigationRow {
  last_viewed_at: string;
}

interface FavoriteRow extends NavigationRow {
  favorited_at: string;
}

interface TrashRow extends NavigationRow {
  trashed_at: string;
  parent_status: "active" | "trashed" | null;
}

export class KnowledgeOrganizationService {
  readonly #repository: D1WikiRepository;
  readonly #authorization: AuthorizationService;

  public constructor(private readonly database: D1Database) {
    this.#repository = new D1WikiRepository(database);
    this.#authorization = new AuthorizationService(this.#repository);
  }

  public async recordPageView(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<void> {
    await this.requireVisiblePage(identity, pageId, false);
    const now = new Date().toISOString();
    await this.database
      .prepare(
        `INSERT INTO user_page_state
           (user_id, page_id, favorited_at, last_viewed_at)
         VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT(user_id, page_id) DO UPDATE SET
           last_viewed_at = excluded.last_viewed_at`,
      )
      .bind(identity.id, pageId, now)
      .run();
  }

  public async setFavorite(
    identity: AuthenticatedIdentity,
    pageId: string,
    favorite: boolean,
  ): Promise<void> {
    await this.requireVisiblePage(identity, pageId, false);
    if (favorite) {
      await this.database
        .prepare(
          `INSERT INTO user_page_state
             (user_id, page_id, favorited_at, last_viewed_at)
           VALUES (?1, ?2, ?3, NULL)
           ON CONFLICT(user_id, page_id) DO UPDATE SET
             favorited_at = excluded.favorited_at`,
        )
        .bind(identity.id, pageId, new Date().toISOString())
        .run();
      return;
    }

    await this.database.batch([
      this.database
        .prepare(
          `UPDATE user_page_state SET favorited_at = NULL
            WHERE user_id = ?1 AND page_id = ?2`,
        )
        .bind(identity.id, pageId),
      this.database
        .prepare(
          `DELETE FROM user_page_state
            WHERE user_id = ?1 AND page_id = ?2
              AND favorited_at IS NULL AND last_viewed_at IS NULL`,
        )
        .bind(identity.id, pageId),
    ]);
  }

  public async listRecent(
    identity: AuthenticatedIdentity,
  ): Promise<RecentPageItem[]> {
    this.requireActiveIdentity(identity);
    const result = await this.database
      .prepare(
        `SELECT p.id, p.parent_id, p.slug, p.title, p.access_mode, p.updated_at,
                state.last_viewed_at
           FROM user_page_state AS state
           JOIN pages AS p ON p.id = state.page_id
          WHERE state.user_id = ?1 AND state.last_viewed_at IS NOT NULL
            AND p.workspace_id = ?2 AND p.status = 'active'
          ORDER BY state.last_viewed_at DESC, p.id
          LIMIT ?3`,
      )
      .bind(identity.id, identity.workspaceId, CANDIDATE_LIMIT)
      .all<RecentRow>();
    const visible = await this.filterVisible(identity, result.results);
    return visible.slice(0, COLLECTION_LIMIT).map((row) => ({
      ...mapNavigation(row),
      lastViewedAt: row.last_viewed_at,
    }));
  }

  public async listFavorites(
    identity: AuthenticatedIdentity,
  ): Promise<FavoritePageItem[]> {
    this.requireActiveIdentity(identity);
    const result = await this.database
      .prepare(
        `SELECT p.id, p.parent_id, p.slug, p.title, p.access_mode, p.updated_at,
                state.favorited_at
           FROM user_page_state AS state
           JOIN pages AS p ON p.id = state.page_id
          WHERE state.user_id = ?1 AND state.favorited_at IS NOT NULL
            AND p.workspace_id = ?2 AND p.status = 'active'
          ORDER BY state.favorited_at DESC, p.id
          LIMIT ?3`,
      )
      .bind(identity.id, identity.workspaceId, CANDIDATE_LIMIT)
      .all<FavoriteRow>();
    const visible = await this.filterVisible(identity, result.results);
    return visible.slice(0, COLLECTION_LIMIT).map((row) => ({
      ...mapNavigation(row),
      favoritedAt: row.favorited_at,
    }));
  }

  public async listTrash(
    identity: AuthenticatedIdentity,
  ): Promise<TrashedPageItem[]> {
    this.requireActiveIdentity(identity);
    const result = await this.database
      .prepare(
        `SELECT p.id, p.parent_id, p.slug, p.title, p.access_mode, p.updated_at,
                p.trashed_at, parent.status AS parent_status
           FROM pages AS p
           LEFT JOIN pages AS parent ON parent.id = p.parent_id
          WHERE p.workspace_id = ?1 AND p.status = 'trashed'
            AND p.trashed_at IS NOT NULL
            AND p.trashed_at >= ?2
            AND (
              parent.id IS NULL OR parent.status = 'active'
              OR parent.trash_batch_id IS NOT p.trash_batch_id
            )
          ORDER BY p.trashed_at DESC, p.id
          LIMIT ?3`,
      )
      .bind(
        identity.workspaceId,
        new Date(Date.now() - TRASH_RETENTION_MILLISECONDS).toISOString(),
        CANDIDATE_LIMIT,
      )
      .all<TrashRow>();
    const visible = await this.filterVisible(identity, result.results);
    return visible.slice(0, COLLECTION_LIMIT).map((row) => ({
      ...mapNavigation(row),
      trashedAt: row.trashed_at,
      restorable: row.parent_id === null || row.parent_status === "active",
    }));
  }

  private async requireVisiblePage(
    identity: AuthenticatedIdentity,
    pageId: string,
    includeTrashed: boolean,
  ): Promise<Page> {
    const page = await this.#repository.getPage(pageId);
    if (
      page?.workspaceId !== identity.workspaceId ||
      (!includeTrashed && page.status !== "active") ||
      !canView(await this.#authorization.effectivePermission(identity, pageId))
    ) {
      throw new ApiProblem(
        "PAGE_NOT_FOUND",
        404,
        "Page was not found or is not visible",
      );
    }
    return page;
  }

  private requireActiveIdentity(identity: AuthenticatedIdentity): void {
    if (identity.status !== "active") {
      throw new ApiProblem("FORBIDDEN", 403, "This account is suspended");
    }
  }

  private async filterVisible<Row extends NavigationRow>(
    identity: AuthenticatedIdentity,
    rows: Row[],
  ): Promise<Row[]> {
    const permissions = await Promise.all(
      rows.map((row) => this.#authorization.effectivePermission(identity, row.id)),
    );
    return rows.filter((_row, index) => canView(permissions[index] ?? "none"));
  }
}

function mapNavigation(row: NavigationRow): PageNavigationItem {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    title: row.title,
    accessMode: row.access_mode,
    updatedAt: row.updated_at,
  };
}
