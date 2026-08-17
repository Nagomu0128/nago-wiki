import { createUuidV7 } from "../core/ids";

export async function recordChatAudit(
  database: D1Database,
  input: {
    provider: "web" | "mcp" | "discord" | "line";
    userId: string;
    query: string;
    pageIds: string[];
    answerSummary: string;
  },
): Promise<void> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
  await database
    .prepare(
      `INSERT INTO chat_audit
         (id, provider, user_id, query, page_ids_json, answer_summary,
          created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      createUuidV7(),
      input.provider,
      input.userId,
      truncateUtf8(input.query, 16_384),
      JSON.stringify([...new Set(input.pageIds)].slice(0, 200)),
      truncateUtf8(input.answerSummary, 16_384),
      createdAt.toISOString(),
      expiresAt.toISOString(),
    )
    .run();
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}
