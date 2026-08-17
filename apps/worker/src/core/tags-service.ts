import type { AuthenticatedIdentity } from "@nago-wiki/shared";

import { AuthorizationService, canEdit } from "./authorization";
import { ApiProblem } from "./errors";
import { createUuidV7 } from "./ids";
import { D1WikiRepository } from "./repository";

export interface WikiTag {
  id: string;
  name: string;
}

export class TagsService {
  private readonly repository: D1WikiRepository;
  private readonly authorization: AuthorizationService;

  public constructor(private readonly database: D1Database) {
    this.repository = new D1WikiRepository(database);
    this.authorization = new AuthorizationService(this.repository);
  }

  public async listVisible(identity: AuthenticatedIdentity): Promise<WikiTag[]> {
    const tree = await this.repository.listVisiblePageTree(identity);
    const visiblePageIds = new Set<string>();
    const visit = (nodes: typeof tree): void => {
      for (const node of nodes) {
        visiblePageIds.add(node.id);
        visit(node.children);
      }
    };
    visit(tree);
    if (visiblePageIds.size === 0) return [];
    const rows = await this.database
      .prepare(
        `SELECT tags.id, tags.name, page_tags.page_id
           FROM tags
           JOIN page_tags ON page_tags.tag_id = tags.id
          WHERE tags.workspace_id = ?1
          ORDER BY tags.normalized_name`,
      )
      .bind(identity.workspaceId)
      .all<WikiTag & { page_id: string }>();
    const tags = new Map<string, WikiTag>();
    for (const row of rows.results) {
      if (visiblePageIds.has(row.page_id)) {
        tags.set(row.id, { id: row.id, name: row.name });
      }
    }
    return [...tags.values()];
  }

  public async replacePageTags(
    identity: AuthenticatedIdentity,
    pageId: string,
    names: string[],
  ): Promise<WikiTag[]> {
    const page = await this.repository.getPage(pageId);
    if (page?.workspaceId !== identity.workspaceId || page.status !== "active") {
      throw new ApiProblem("PAGE_NOT_FOUND", 404, "Page was not found or is not visible");
    }
    if (!canEdit(await this.authorization.effectivePermission(identity, pageId))) {
      throw new ApiProblem("FORBIDDEN", 403, "Editor permission is required");
    }
    const normalized = new Map<string, string>();
    for (const name of names) {
      const trimmed = name.trim();
      const key = trimmed.normalize("NFKC").toLocaleLowerCase("en-US");
      if (trimmed.length > 0) normalized.set(key, trimmed);
    }
    const now = new Date().toISOString();
    await this.database.batch([
      ...[...normalized].map(([key, name]) =>
        this.database
          .prepare(
            `INSERT OR IGNORE INTO tags
               (id, workspace_id, name, normalized_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(createUuidV7(), identity.workspaceId, name, key, now),
      ),
      this.database.prepare(`DELETE FROM page_tags WHERE page_id = ?1`).bind(pageId),
      ...[...normalized.keys()].map((key) =>
        this.database
          .prepare(
            `INSERT INTO page_tags (page_id, tag_id)
             SELECT ?1, id FROM tags
              WHERE workspace_id = ?2 AND normalized_name = ?3`,
          )
          .bind(pageId, identity.workspaceId, key),
      ),
    ]);
    return this.repository.getTagsForPage(pageId);
  }
}
