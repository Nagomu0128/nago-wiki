import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverLineBotResponse } from "../../src/jobs/consumer";
import type { BotQueryJob } from "../../src/jobs/contracts";
import type { McpRuntimeEnv } from "../../src/mcp/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LINE bot delivery", () => {
  it("prefers reply while the reply token is inside its safe lifetime", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job(), "answer", 1_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.line.me/v2/bot/message/reply");
  });

  it("falls back to an idempotent push when LINE rejects the reply token", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job(), "answer", 1_000);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/push",
    ]);
  });

  it("uses push without attempting reply after the safe lifetime", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverLineBotResponse(environment(), job({ replyExpiresAt: 1_000 }), "answer", 1_000);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/message/push",
    ]);
  });

  it("retries transient reply failures instead of risking a duplicate push", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("retryable status 503");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a rate-limited reply instead of falling back to push", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("retryable status 429");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a network failure instead of risking a duplicate push", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network error"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("did not complete");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails permanently for reply errors other than 400", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 408 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverLineBotResponse(environment(), job(), "answer", 1_000))
      .rejects.toThrow("permanent status 408");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function environment(): McpRuntimeEnv {
  return { LINE_CHANNEL_ACCESS_TOKEN: "token" } as McpRuntimeEnv;
}

function job(overrides: Partial<BotQueryJob["response"]> = {}): BotQueryJob {
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
