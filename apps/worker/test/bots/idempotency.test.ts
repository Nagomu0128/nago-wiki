import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { answerBotQuery } from "../../src/bots/service";
import type { McpRuntimeEnv } from "../../src/mcp/types";

describe("bot answer idempotency", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bot_events").run();
  });

  it("replays the persisted answer without calling AI after delivery retry", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO bot_events
         (provider, event_id, user_id, status, response_hash, response_text,
          created_at, updated_at)
       VALUES ('line', 'event-1', NULL, 'completed', ?1, '保存済み回答', ?2, ?2)`,
    )
      .bind("a".repeat(64), now)
      .run();

    await expect(
      answerBotQuery({ DB: env.DB } as unknown as McpRuntimeEnv, {
        provider: "line",
        eventId: "event-1",
        externalUserId: "line-user",
        externalChannelId: null,
        query: "質問",
      }),
    ).resolves.toBe("保存済み回答");
  });
});
