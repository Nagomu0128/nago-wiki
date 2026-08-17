const wikiLinkPattern = /\[\[([^\]|\r\n]+)(?:\|[^\]\r\n]*)?\]\]/gu;

export function extractWikiLinkTargets(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(wikiLinkPattern)) {
    const target = match[1]?.trim();
    if (target !== undefined && target.length > 0 && target.length <= 4_096) {
      targets.add(target);
    }
  }
  return [...targets];
}

export async function refreshPageLinks(
  database: D1Database,
  input: {
    workspaceId: string;
    pageId: string;
    revision: number;
    markdown: string;
  },
): Promise<void> {
  const targets = extractWikiLinkTargets(input.markdown);
  const resolved = await Promise.all(
    targets.map(async (rawTarget) => ({
      rawTarget,
      targetPageId: await resolveTarget(database, input.workspaceId, rawTarget),
    })),
  );
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `DELETE FROM page_links
          WHERE source_page_id = ?1 AND source_revision <= ?2`,
      )
      .bind(input.pageId, input.revision),
    ...resolved.map(({ rawTarget, targetPageId }) =>
      database
        .prepare(
          `INSERT OR REPLACE INTO page_links
             (source_page_id, target_page_id, raw_target, source_revision, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5
             FROM pages
            WHERE id = ?1 AND workspace_id = ?6 AND revision = ?4
              AND status = 'active'`,
        )
        .bind(
          input.pageId,
          targetPageId,
          rawTarget,
          input.revision,
          now,
          input.workspaceId,
        ),
    ),
  ]);
}

async function resolveTarget(
  database: D1Database,
  workspaceId: string,
  rawTarget: string,
): Promise<string | null> {
  const normalized = normalizeWikiPath(rawTarget);
  const alias = await database
    .prepare(
      `SELECT page_id FROM page_aliases
        WHERE workspace_id = ?1 AND normalized_path = ?2`,
    )
    .bind(workspaceId, normalized)
    .first<{ page_id: string }>();
  if (alias !== null) return alias.page_id;

  const slug = normalized.split("/").at(-1) ?? "";
  const matches = await database
    .prepare(
      `SELECT id FROM pages
        WHERE workspace_id = ?1 AND lower(slug) = ?2 AND status = 'active'
        ORDER BY id LIMIT 2`,
    )
    .bind(workspaceId, slug)
    .all<{ id: string }>();
  return matches.results.length === 1 ? (matches.results[0]?.id ?? null) : null;
}

function normalizeWikiPath(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .toLocaleLowerCase("en-US");
}
