import { afterEach, describe, expect, it, vi } from "vitest";

import { extractLineQuery, sendLineReply } from "../../src/bots/line";

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

  it("falls back to a push when the reply token has expired", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("expired", { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendLineReply(
      { LINE_CHANNEL_ACCESS_TOKEN: "token" },
      "expired-reply-token",
      "回答",
      "line-user",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.line.me/v2/bot/message/push",
    );
  });
});
