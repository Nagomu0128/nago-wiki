import type { RealtimePermission } from "./types";

interface PermissionRow {
  permission: RealtimePermission | null;
}

/** Resolves current D1 membership and inherited page ACL state for a socket. */
export class D1RealtimePermissionAuthorizer {
  public constructor(private readonly database: D1Database) {}

  public async permission(
    workspaceId: string,
    pageId: string,
    userId: string,
  ): Promise<RealtimePermission | null> {
    const row = await this.database.prepare(
      `WITH RECURSIVE lineage(id, parent_id, access_mode) AS (
         SELECT id, parent_id, access_mode
           FROM pages
          WHERE id = ?2 AND workspace_id = ?1 AND status = 'active'
         UNION ALL
         SELECT parent.id, parent.parent_id, parent.access_mode
           FROM pages AS parent
           JOIN lineage ON parent.id = lineage.parent_id
          WHERE parent.workspace_id = ?1 AND parent.status = 'active'
       )
       SELECT CASE
         WHEN member.role = 'owner' THEN 'editor'
         WHEN EXISTS (
           SELECT 1 FROM lineage AS restricted
            WHERE restricted.access_mode = 'restricted'
              AND NOT EXISTS (
                SELECT 1 FROM page_acl
                 WHERE page_acl.page_id = restricted.id
                   AND page_acl.user_id = ?3
                   AND page_acl.permission IN ('viewer', 'editor')
              )
         ) THEN NULL
         WHEN member.role = 'viewer' THEN 'viewer'
         WHEN EXISTS (
           SELECT 1 FROM lineage AS restricted
           JOIN page_acl ON page_acl.page_id = restricted.id
                        AND page_acl.user_id = ?3
          WHERE restricted.access_mode = 'restricted'
            AND page_acl.permission = 'viewer'
         ) THEN 'viewer'
         ELSE 'editor'
       END AS permission
       FROM pages AS page
       JOIN users AS member ON member.id = ?3
                           AND member.workspace_id = ?1
                           AND member.status = 'active'
      WHERE page.id = ?2
        AND page.workspace_id = ?1
        AND page.status = 'active'`,
    )
      .bind(workspaceId, pageId, userId)
      .first<PermissionRow>();
    return row?.permission ?? null;
  }
}
