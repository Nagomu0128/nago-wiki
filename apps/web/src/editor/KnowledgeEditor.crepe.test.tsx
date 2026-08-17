// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { PageResource, WikiApi } from "../api";
import { replaceSharedMarkdown, type RealtimeProviderFactory } from "../realtime";
import { flushUi, renderView, type RenderedView } from "../test/render";
import { KnowledgeEditor } from "./KnowledgeEditor";

const resource: PageResource = {
  page: {
    id: "30000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    parentId: null,
    slug: "crepe-test",
    title: "Crepe test",
    bodyMd: "# Initial body",
    revision: 1,
    contentHash: "a".repeat(64),
    accessMode: "workspace",
    status: "active",
    createdBy: "20000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    trashedAt: null,
  },
  permission: "editor",
  tags: [],
};

describe("KnowledgeEditor Crepe binding", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("renders the REST snapshot and applies remote Y.Text markdown", async () => {
    let sharedDocument: Y.Doc | undefined;
    const realtime: RealtimeProviderFactory = {
      connect({ document, permission }) {
        sharedDocument = document;
        return {
          document,
          status: "connected",
          permission,
          subscribeStatus(listener) { listener("connected"); return () => undefined; },
          subscribePermission(listener) { listener(permission); return () => undefined; },
          destroy() { /* The editor owns the Y.Doc lifecycle. */ },
        };
      },
    };
    view = await renderView(
      <KnowledgeEditor api={{} as WikiApi} realtimeFactory={realtime} resource={resource} />,
    );
    await flushUi();
    await flushUi();
    const editor = view.container.querySelector<HTMLElement>("[contenteditable='true']");

    expect(editor?.getAttribute("aria-label")).toBe("Markdown本文");
    expect(editor?.textContent).toContain("Initial body");
    if (!sharedDocument) throw new Error("Realtime document was not connected");
    const connectedDocument = sharedDocument;
    act(() => { replaceSharedMarkdown(connectedDocument, "# Remote body", Symbol("remote")); });
    await flushUi();

    expect(editor?.textContent).toContain("Remote body");
    expect(connectedDocument.getText("markdown").toJSON()).toBe("# Remote body");
    expect(connectedDocument.share.has("prosemirror")).toBe(false);
  });
});
