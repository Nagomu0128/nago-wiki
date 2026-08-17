import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localMarkdownOrigin, replaceSharedMarkdown } from "./markdown";

describe("replaceSharedMarkdown", () => {
  it("updates the realtime markdown Y.Text with a minimal transaction", () => {
    const document = new Y.Doc();
    const shared = document.getText("markdown");
    shared.insert(0, "alpha middle omega");
    let observedOrigin: unknown;
    shared.observe((_event, transaction) => { observedOrigin = transaction.origin; });

    expect(replaceSharedMarkdown(document, "alpha changed omega")).toBe(true);

    expect(shared.toJSON()).toBe("alpha changed omega");
    expect(observedOrigin).toBe(localMarkdownOrigin);
    expect(document.share.has("prosemirror")).toBe(false);
    expect(replaceSharedMarkdown(document, "alpha changed omega")).toBe(false);
  });
});
