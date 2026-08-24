import { describe, expect, it } from "vitest";

import { extractWikiLinkTargets } from "../src/jobs/wiki-links";

describe("wiki link extraction", () => {
  it("extracts unique path targets and omits display labels", () => {
    expect(
      extractWikiLinkTargets(
        "See [[Guides/Cloudflare|Cloudflare]] and [[Inbox]]. Again [[Inbox]].",
      ),
    ).toEqual(["Guides/Cloudflare", "Inbox"]);
  });

  it("does not cross line boundaries for malformed links", () => {
    expect(extractWikiLinkTargets("[[broken\nlink]]")).toEqual([]);
  });
});
