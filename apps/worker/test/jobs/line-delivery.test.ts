import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeAsyncJobs, deliverLineBotResponse } from "../../src/jobs/consumer";
import { asyncJobSchema, type BotQueryJob } from "../../src/jobs/contracts";
import type { McpRuntimeEnv } from "../../src/mcp/types";

describe("LINE bot delivery", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bot_events").run();
    await seedEvent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers reply while the reply token is inside its safe lifetime", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job(), "answer", 1_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.line.me/v2/bot/message/reply");
    await expect(deliveryState()).resolves.toBe("delivered");
  });

  it("does not send again when Queue redelivers after a successful reply", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job(), "answer", 1_000);
    await deliverLineBotResponse(environment(), job(), "answer", 1_000);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not send a push when Queue redelivers after reply success and ACK loss", async () => {
    await completeEvent();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = job({ replyExpiresAt: Date.now() + 5_000 });
    const first = queueMessage(body);
    const redelivery = queueMessage(body);

    await consumeAsyncJobs({ messages: [first] } as unknown as MessageBatch, environment());
    await consumeAsyncJobs({ messages: [redelivery] } as unknown as MessageBatch, environment());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(redelivery.ack).toHaveBeenCalledOnce();
  });

  it("falls back to an idempotent push only when the initial reply gets a 400", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job(), "answer", 1_000);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/push",
    ]);
    await expect(deliveryState()).resolves.toBe("delivered");
  });

  it("uses push without attempting reply after the safe lifetime", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job({ replyExpiresAt: 1_000 }), "answer", 1_000);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/push",
    ]);
  });

  it("retries an already claimed push fallback with its idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("LINE push failed with status 503");
    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/push",
      "https://api.line.me/v2/bot/message/push",
    ]);
    await expect(deliveryState()).resolves.toBe("delivered");
  });

  it("never falls back to push after an ambiguous reply attempt", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("did not complete");
    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/reply",
    ]);
    await expect(deliveryState()).resolves.toBe("permanent_failure");
  });

  it("retries rate-limited replies without falling back to push", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("retryable status 429");
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(deliveryState()).resolves.toBe("reply_attempted");
  });

  it("retries server reply failures without falling back to push", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("retryable status 503");
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(deliveryState()).resolves.toBe("reply_attempted");
  });

  it("fails permanently for reply errors other than 400", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 408 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("permanent status 408");
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(deliveryState()).resolves.toBe("permanent_failure");
  });

  it("keeps rolling-deployment legacy queue jobs on the push path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const legacy = legacyJob();
    expect(asyncJobSchema.safeParse(legacy).success).toBe(true);
    await deliverLineBotResponse(environment(), legacy, "answer", 1_000);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/push",
    ]);
  });

  it("acks permanent reply failures instead of scheduling Queue retries", async () => {
    await completeEvent();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = queueMessage(job({ replyExpiresAt: Date.now() + 5_000 }));

    await consumeAsyncJobs({ messages: [message] } as unknown as MessageBatch, environment());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("schedules Queue retries for ambiguous reply failures", async () => {
    await completeEvent();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network error")));
    const message = queueMessage(job({ replyExpiresAt: Date.now() + 5_000 }));

    await consumeAsyncJobs({ messages: [message] } as unknown as MessageBatch, environment());

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
  });

  it("does not add the reply token to D1", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(bot_events)")
      .all<{ name: string }>();

    expect(columns.results.map((column) => column.name)).not.toContain("reply_token");
  });
});

function environment(): McpRuntimeEnv {
  return { DB: env.DB, LINE_CHANNEL_ACCESS_TOKEN: "token" } as McpRuntimeEnv;
}

function job(overrides: Partial<Extract<BotQueryJob["response"], { kind: "line-reply-then-push" }>> = {}): BotQueryJob {
  return {
    type: "bot-query",
    jobId: "job-1",
    provider: "line",
    eventId: "line-event-1",
    externalUserId: "line-user",
    externalChannelId: null,
    query: "question",
    response: {
      kind: "line-reply-then-push",
      replyToken: "reply-token",
      replyExpiresAt: 5_000,
      ...overrides,
    },
  };
}

function legacyJob(): BotQueryJob {
  return { ...job(), response: { kind: "line-push" } };
}

function queueMessage(body: BotQueryJob): Pick<Message, "ack" | "attempts" | "body" | "id" | "retry"> {
  return {
    ack: vi.fn(),
    attempts: 1,
    body,
    id: "message-1",
    retry: vi.fn(),
  };
}

async function seedEvent(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bot_events
       (provider, event_id, user_id, status, response_hash, created_at, updated_at)
     VALUES ('line', 'line-event-1', NULL, 'received', NULL, ?1, ?1)`,
  )
    .bind(now)
    .run();
}

async function completeEvent(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE bot_events
        SET status = 'completed', response_hash = ?1, response_text = 'answer', updated_at = ?2
      WHERE provider = 'line' AND event_id = 'line-event-1'`,
  )
    .bind("a".repeat(64), now)
    .run();
}

async function deliveryState(): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT line_delivery_state FROM bot_events
      WHERE provider = 'line' AND event_id = 'line-event-1'`,
  )
    .first<{ line_delivery_state: string }>();
  return row?.line_delivery_state ?? null;
}
