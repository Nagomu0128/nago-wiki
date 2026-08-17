import { describe, expect, it } from "vitest";
import { normalizeMentionQuery } from "./index";

describe("normalizeMentionQuery", () => {
  it("removes the bot mention and surrounding whitespace", () => {
    expect(normalizeMentionQuery("  <@42> Wikiを検索して  ", "42")).toBe(
      "Wikiを検索して",
    );
  });
});
