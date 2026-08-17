import type { McpRuntimeEnv } from "../mcp/types";

interface PendingVersionRow {
  version_id: string;
}

interface PendingIndexRow {
  page_id: string;
  workspace_id: string;
  desired_hash: string;
}

export async function reconcilePendingJobs(environment: McpRuntimeEnv): Promise<void> {
  const [versions, indexes] = await Promise.all([
    environment.DB.prepare(
      `SELECT version_id FROM page_version_outbox
        WHERE available_at <= ?1 ORDER BY available_at ASC LIMIT 50`,
    )
      .bind(new Date().toISOString())
      .all<PendingVersionRow>(),
    environment.DB.prepare(
      `SELECT state.page_id, pages.workspace_id, state.desired_hash
         FROM index_state AS state
         JOIN pages ON pages.id = state.page_id
        WHERE state.status IN ('pending', 'error') AND pages.status = 'active'
        ORDER BY state.updated_at ASC LIMIT 50`,
    ).all<PendingIndexRow>(),
  ]);
  const messages: MessageSendRequest[] = [
    ...versions.results.map((value) => ({
      body: {
        type: "persist-version",
        jobId: crypto.randomUUID(),
        versionId: value.version_id,
      },
      contentType: "json" as const,
    })),
    ...indexes.results.map((value) => ({
      body: {
        type: "index-page",
        jobId: crypto.randomUUID(),
        workspaceId: value.workspace_id,
        pageId: value.page_id,
        desiredHash: value.desired_hash,
      },
      contentType: "json" as const,
    })),
  ];
  for (let index = 0; index < messages.length; index += 100) {
    await environment.ASYNC_JOBS.sendBatch(messages.slice(index, index + 100));
  }
}
