import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordMessageNonce,
  fetchBridgeWithRetry,
  normalizeMentionQuery,
  RemoteDiscordSessionStore,
  splitDiscordMessage,
} from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeMentionQuery", () => {
  it("removes the bot mention and surrounding whitespace", () => {
    expect(normalizeMentionQuery("  <@42> Wikiを検索して  ", "42")).toBe(
      "Wikiを検索して",
    );
  });
});

describe("splitDiscordMessage", () => {
  it("keeps each reply under Discord's message limit", () => {
    const chunks = splitDiscordMessage("a".repeat(4_500));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 1_900)).toBe(true);
  });
});

describe("discordMessageNonce", () => {
  it("creates stable per-chunk nonces within Discord's 25 character limit", () => {
    expect(discordMessageNonce("12345678901234567890", 0)).toBe(
      "12345678901234567890:0",
    );
    expect(discordMessageNonce("12345678901234567890", 1)).not.toBe(
      discordMessageNonce("12345678901234567890", 0),
    );
    expect(discordMessageNonce("x".repeat(100), 99)).toHaveLength(23);
  });
});

describe("fetchBridgeWithRetry", () => {
  it("polls an in-progress duplicate and signs every retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 202,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response('{"answer":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchBridgeWithRetry(
      new URL("https://wiki.example/api/v1/internal/bot-query"),
      '{"eventId":"1"}',
      "bridge-secret",
      { timeoutMs: 1_000, sleep: () => Promise.resolve() },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      expect(typeof headers?.["x-nago-timestamp"]).toBe("string");
      expect(typeof headers?.["x-nago-signature"]).toBe("string");
    }
  });
});

describe("RemoteDiscordSessionStore", () => {
  it("loads and persists resumable Gateway state through signed requests", async () => {
    const session = {
      resumeURL: "wss://gateway.discord.gg",
      sequence: 42,
      sessionId: "session-1",
      shardCount: 1,
      shardId: 0,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ session }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = new RemoteDiscordSessionStore(
      "https://wiki.example",
      "bridge-secret",
      fetchMock,
    );

    await expect(store.get(0)).resolves.toEqual(session);
    await store.put(0, session);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInput = fetchMock.mock.calls[0]?.[0];
    if (!(firstInput instanceof URL)) throw new Error("Expected a session URL");
    expect(firstInput.pathname).toBe("/api/v1/internal/discord-session/0");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ session }),
    });
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      expect(headers?.["x-nago-signature"]).toMatch(/^[a-f\d]{64}$/u);
    }
  });
});
