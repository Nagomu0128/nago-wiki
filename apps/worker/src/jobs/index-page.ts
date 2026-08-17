import type { IndexPageJob } from "./contracts";

interface IndexablePageRow {
  id: string;
  workspace_id: string;
  title: string;
  body_md: string;
  content_hash: string;
  status: string;
}

export interface PageIndexDependencies {
  database: D1Database;
  search: AiSearchInstance;
}

export async function indexPage(
  dependencies: PageIndexDependencies,
  job: IndexPageJob,
): Promise<"indexed" | "superseded" | "deleted"> {
  const page = await dependencies.database
    .prepare(
      `SELECT id, workspace_id, title, body_md, content_hash, status
         FROM pages
        WHERE id = ?1 AND workspace_id = ?2`,
    )
    .bind(job.pageId, job.workspaceId)
    .first<IndexablePageRow>();

  if (page?.status !== "active") {
    await markDeleted(dependencies.database, job.pageId);
    return "deleted";
  }
  if (page.content_hash !== job.desiredHash) {
    return "superseded";
  }

  const key = `w/${job.workspaceId}/p/${job.pageId}.md`;
  try {
    await dependencies.search.items.upload(key, renderIndexDocument(page), {
      metadata: {
        workspace_id: job.workspaceId,
        page_id: job.pageId,
        content_hash: page.content_hash,
        language: "ja",
        kind: "page",
      },
    });
    await dependencies.database
      .prepare(
        `UPDATE index_state
            SET indexed_hash = ?2,
                status = 'queued',
                last_error = NULL,
                updated_at = unixepoch()
          WHERE page_id = ?1 AND desired_hash = ?2`,
      )
      .bind(page.id, page.content_hash)
      .run();
    return "indexed";
  } catch (error) {
    await dependencies.database
      .prepare(
        `UPDATE index_state
            SET status = 'error', last_error = ?2, updated_at = unixepoch()
          WHERE page_id = ?1`,
      )
      .bind(page.id, errorMessage(error))
      .run();
    throw error;
  }
}

function renderIndexDocument(page: IndexablePageRow): string {
  return `# ${page.title}\n\n${page.body_md}`;
}

async function markDeleted(database: D1Database, pageId: string): Promise<void> {
  await database
    .prepare(
      `UPDATE index_state
          SET status = 'deleted', last_error = NULL, updated_at = unixepoch()
        WHERE page_id = ?1`,
    )
    .bind(pageId)
    .run();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "Unknown indexing error";
}
