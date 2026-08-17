import { describe, expect, it } from "vitest";
import { normalizeMentionQuery, splitDiscordMessage } from "./index";

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
