import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { answerBotQuery, claimBotEvent } from "../../src/bots/service";
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

  it("allows only one concurrent processing lease", async () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    await env.DB.prepare(
      `INSERT INTO bot_events
         (provider, event_id, user_id, status, response_hash, response_text,
          created_at, updated_at)
       VALUES ('line', 'event-lease', NULL, 'received', NULL, NULL, ?1, ?1)`,
    )
      .bind(now.toISOString())
      .run();

    const claims = await Promise.all([
      claimBotEvent(env.DB, "line", "event-lease", now),
      claimBotEvent(env.DB, "line", "event-lease", now),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(
      claimBotEvent(
        env.DB,
        "line",
        "event-lease",
        new Date(now.getTime() + 5 * 60 * 1_000 + 1),
      ),
    ).resolves.not.toBeNull();
  });
});
