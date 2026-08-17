import { describe, expect, it } from "vitest";

import { extractLineQuery } from "../../src/bots/line";

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
});
