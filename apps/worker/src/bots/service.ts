import { D1SearchCandidateAuthorizer } from "../ai/authorizer";
import { recordChatAudit } from "../ai/audit";
import { WikiAnswerService, WorkersAiAnswerModel } from "../ai/answer-service";
import { WikiSearchService } from "../ai/search-service";
import type { McpRuntimeEnv } from "../mcp/types";
import { consumeAccountLinkCode, resolveExternalUser } from "./account-link";

export interface BotQueryInput {
  provider: "discord" | "line";
  eventId: string;
  externalUserId: string;
  externalChannelId: string | null;
  query: string;
}

interface WorkspaceRow {
  id: string;
}

interface AllowlistRow {
  workspace_id: string;
}

export async function reserveBotEvent(
  database: D1Database,
  provider: BotQueryInput["provider"],
  eventId: string,
): Promise<boolean> {
  const marker = `${new Date().toISOString()}#${crypto.randomUUID()}`;
  await database
    .prepare(
      `INSERT OR IGNORE INTO bot_events
         (provider, event_id, user_id, status, response_hash, created_at, updated_at)
       VALUES (?1, ?2, NULL, 'received', NULL, ?3, ?3)`,
    )
    .bind(provider, eventId, marker)
    .run();
  const value = await database
    .prepare(
      `SELECT created_at FROM bot_events WHERE provider = ?1 AND event_id = ?2`,
    )
    .bind(provider, eventId)
    .first<{ created_at: string }>();
  return value?.created_at === marker;
}

export async function answerBotQuery(
  environment: McpRuntimeEnv,
  input: BotQueryInput,
): Promise<string | null> {
  const workspaceId = await resolveWorkspace(
    environment.DB,
    input.provider,
    input.externalChannelId,
  );
  if (workspaceId === null) {
    await finishEvent(environment.DB, input, null, "ignored", null);
    return null;
  }

  const linkCode = parseLinkCode(input.query);
  if (linkCode !== null) {
    const linked = await consumeAccountLinkCode(
      environment.DB,
      input.provider,
      input.externalUserId,
      linkCode,
    );
    const response = linked
      ? "Wikiアカウントとの連携が完了しました。"
      : "連携コードが無効または期限切れです。Wikiから新しいコードを発行してください。";
    const userId = await resolveExternalUser(
      environment,
      input.provider,
      input.externalUserId,
    );
    await finishEvent(environment.DB, input, userId, "completed", response);
    return response;
  }

  const userId = await resolveExternalUser(
    environment,
    input.provider,
    input.externalUserId,
  );
  if (userId === null) {
    const response =
      "Wikiアカウントが未連携です。Wikiのアカウント連携画面でコードを発行し、「link <コード>」と送信してください。";
    await finishEvent(environment.DB, input, null, "completed", response);
    return response;
  }

  await environment.DB.prepare(
    `UPDATE bot_events SET user_id = ?3, status = 'processing', updated_at = ?4
      WHERE provider = ?1 AND event_id = ?2`,
  )
    .bind(input.provider, input.eventId, userId, new Date().toISOString())
    .run();

  if (!(await consumeBotRateLimit(environment.DB, userId, workspaceId))) {
    const response = "利用が集中しています。1分ほど待ってから、もう一度お試しください。";
    await finishEvent(environment.DB, input, userId, "completed", response);
    return response;
  }

  const publicOrigin = new URL(environment.MCP_PUBLIC_ORIGIN).origin;
  const search = new WikiSearchService(
    environment.WIKI_SEARCH,
    new D1SearchCandidateAuthorizer(environment.DB, publicOrigin),
  );
  const answer = new WikiAnswerService(
    search,
    new WorkersAiAnswerModel(
      environment.AI,
      environment.ANSWER_MODEL,
      environment.AI_GATEWAY_ID,
    ),
  );
  try {
    const result = await answer.answer(userId, {
      query: input.query,
      workspaceId,
      knowledgeMode: "wiki_only",
      maxCitations: 6,
    });
    await recordChatAudit(environment.DB, {
      provider: input.provider,
      userId,
      query: input.query,
      pageIds: result.citations.map((citation) => citation.pageId),
      answerSummary: result.answer,
    });
    const response = formatBotAnswer(result.answer, result.citations);
    await finishEvent(environment.DB, input, userId, "completed", response);
    return response;
  } catch (error) {
    await finishEvent(environment.DB, input, userId, "failed", null);
    throw error;
  }
}

export async function consumeBotRateLimit(
  database: D1Database,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const userAllowed = await consumeRateLimit(
    database,
    `user:${userId}`,
    windowStart,
    5,
  );
  if (!userAllowed) return false;
  return consumeRateLimit(database, `workspace:${workspaceId}`, windowStart, 30);
}

async function consumeRateLimit(
  database: D1Database,
  scopeKey: string,
  windowStart: number,
  limit: number,
): Promise<boolean> {
  const row = await database
    .prepare(
      `INSERT INTO bot_rate_limits
         (scope_key, window_started_at, request_count, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(scope_key) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         request_count = CASE
           WHEN bot_rate_limits.window_started_at = excluded.window_started_at
             THEN bot_rate_limits.request_count + 1
           ELSE 1
         END,
         updated_at = excluded.updated_at
       RETURNING request_count`,
    )
    .bind(scopeKey, windowStart, new Date().toISOString())
    .first<{ request_count: number }>();
  return row !== null && row.request_count <= limit;
}

async function resolveWorkspace(
  database: D1Database,
  provider: BotQueryInput["provider"],
  externalChannelId: string | null,
): Promise<string | null> {
  if (externalChannelId === null) {
    const workspace = await database
      .prepare(`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`)
      .first<WorkspaceRow>();
    return workspace?.id ?? null;
  }
  const allowed = await database
    .prepare(
      `SELECT workspace_id
         FROM bot_channel_allowlist
        WHERE provider = ?1 AND external_channel_id = ?2 AND enabled = 1`,
    )
    .bind(provider, externalChannelId)
    .first<AllowlistRow>();
  return allowed?.workspace_id ?? null;
}

async function finishEvent(
  database: D1Database,
  input: BotQueryInput,
  userId: string | null,
  status: "completed" | "failed" | "ignored",
  response: string | null,
): Promise<void> {
  const responseHash = response === null ? null : await sha256Hex(response);
  await database
    .prepare(
      `UPDATE bot_events
          SET user_id = ?3, status = ?4, response_hash = ?5, updated_at = ?6
        WHERE provider = ?1 AND event_id = ?2`,
    )
    .bind(
      input.provider,
      input.eventId,
      userId,
      status,
      responseHash,
      new Date().toISOString(),
    )
    .run();
}

function parseLinkCode(query: string): string | null {
  return /^(?:link|連携)\s+(\S+)$/iu.exec(query.trim())?.[1] ?? null;
}

function formatBotAnswer(
  answer: string,
  citations: { title: string; url: string }[],
): string {
  const sources = citations.length === 0
    ? ""
    : `\n\n出典:\n${citations.map((citation, index) => `${String(index + 1)}. ${citation.title} ${citation.url}`).join("\n")}`;
  return `${answer}${sources}`.slice(0, 4_900);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
