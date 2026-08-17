import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBridgeWithRetry,
  normalizeMentionQuery,
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
