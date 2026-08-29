import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLineQuery,
  handleLineWebhook,
  lineRetryKey,
  sendLinePush,
  sendLineReply,
} from "../../src/bots/line";
import { botQueryJobSchema } from "../../src/jobs/contracts";
import type { McpRuntimeEnv } from "../../src/mcp/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LINE mention extraction", () => {
  it("requires the bot mention in group conversations", () => {
    expect(
      extractLineQuery("group", {
        type: "text",
        text: "question",
      }),
    ).toBeNull();
  });

  it("removes only self mentions", () => {
    expect(
      extractLineQuery("group", {
        type: "text",
        text: "@bot 質問です",
        mention: { mentionees: [{ isSelf: true, index: 0, length: 4 }] },
      }),
    ).toBe("質問です");
  });

  it("accepts direct messages without a mention", () => {
    expect(extractLineQuery("user", { type: "text", text: "  質問  " })).toBe("質問");
  });

  it("sends an idempotent push with an event-derived retry key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendLinePush(
      { LINE_CHANNEL_ACCESS_TOKEN: "token" },
      "line-user",
      "回答",
      "line-event-1",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.line.me/v2/bot/message/push",
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    await expect(lineRetryKey("line-event-1")).resolves.toBe(
      headers["x-line-retry-key"],
    );
    expect(headers["x-line-retry-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("treats a duplicate retry key response as delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 })),
    );

    await expect(
      sendLinePush(
        { LINE_CHANNEL_ACCESS_TOKEN: "token" },
        "line-user",
        "answer",
        "line-event-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("sends a reply with the webhook token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendLineReply(
      { LINE_CHANNEL_ACCESS_TOKEN: "token" },
      "reply-token",
      "answer",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/reply",
      expect.objectContaining({
        body: JSON.stringify({
          replyToken: "reply-token",
          messages: [{ type: "text", text: "answer" }],
        }),
      }),
    );
  });

  it("releases the event reservation when Queue enqueue fails", async () => {
    await env.DB.prepare(
      "DELETE FROM bot_events WHERE provider = 'line' AND event_id = ?1",
    )
      .bind("line-event-retry")
      .run();
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "line-event-retry",
          timestamp: Date.now(),
          replyToken: "reply-token",
          source: { type: "user", userId: "line-user" },
          message: { type: "text", text: "質問" },
        },
      ],
    });
    const secret = "line-secret";
    const signature = await lineSignature(body, secret);
    let queueAvailable = false;
    const sentJobs: unknown[] = [];
    const send = vi.fn((job: unknown) => {
      sentJobs.push(job);
      return queueAvailable
        ? Promise.resolve()
        : Promise.reject(new Error("queue unavailable"));
    });
    const environment = {
      DB: env.DB,
      ASYNC_JOBS: { send },
      LINE_CHANNEL_SECRET: secret,
    } as unknown as McpRuntimeEnv;
    const request = () => new Request("https://wiki.example/webhooks/line", {
      method: "POST",
      headers: { "x-line-signature": signature },
      body,
    });

    await expect(handleLineWebhook(request(), environment)).rejects.toThrow(
      "queue unavailable",
    );
    await expect(
      env.DB.prepare(
        "SELECT event_id FROM bot_events WHERE provider = 'line' AND event_id = ?1",
      )
        .bind("line-event-retry")
        .first(),
    ).resolves.toBeNull();

    queueAvailable = true;
    await expect(handleLineWebhook(request(), environment)).resolves.toMatchObject({
      status: 200,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const queuedJob = botQueryJobSchema.parse(sentJobs[1]);
    expect(queuedJob.response.kind).toBe("line-reply-then-push");
    if (queuedJob.response.kind !== "line-reply-then-push") throw new Error("Expected reply job");
    expect(queuedJob.response.replyToken).toBe("reply-token");
    expect(queuedJob.response.replyExpiresAt).toBeGreaterThan(0);
  });
});

async function lineSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCodePoint(byte);
  return btoa(binary);
}
