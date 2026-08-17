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
        WHERE state.status IN ('pending', 'failed') AND pages.status = 'active'
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
  const auditExpiry = new Date().toISOString();
  const staleRateWindow = Date.now() - 60 * 60 * 1_000;
  await environment.DB.batch([
    environment.DB.prepare(`DELETE FROM chat_audit WHERE expires_at <= ?1`).bind(
      auditExpiry,
    ),
    environment.DB.prepare(
      `DELETE FROM bot_rate_limits WHERE window_started_at < ?1`,
    ).bind(staleRateWindow),
    environment.DB.prepare(
      `DELETE FROM account_link_codes
        WHERE expires_at <= ?1 OR consumed_at IS NOT NULL`,
    ).bind(auditExpiry),
  ]);
}
