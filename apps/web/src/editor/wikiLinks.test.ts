import { describe, expect, it } from "vitest";
import { completeWikiLink, extractWikiLinkQuery } from "./wikiLinks";

describe("wiki link helpers", () => {
  it("extracts only an unfinished wiki link at the cursor", () => {
    expect(extractWikiLinkQuery("See [[Arch")).toBe("Arch");
    expect(extractWikiLinkQuery("See [[Architecture]]")).toBeNull();
  });

  it("qualifies nested pages while keeping the readable title", () => {
    expect(completeWikiLink("See [[Arch", {
      pageId: "page-1",
      title: "Architecture",
      path: "/product/architecture",
    })).toEqual({
      markdown: "See [[product/architecture|Architecture]]",
      cursor: 41,
    });
  });
});
