// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageResource, PageTreeNode, WikiApi } from "../api";
import { flushUi, renderView, setInputValue, type RenderedView } from "../test/render";
import { KnowledgeOrganizerDrawer, type KnowledgeOrganizerMode } from "./KnowledgeOrganizerDrawer";

const pageId = "30000000-0000-4000-8000-000000000001";
const parentId = "30000000-0000-4000-8000-000000000002";
const destinationId = "30000000-0000-4000-8000-000000000003";
const page: PageResource = {
  page: {
    id: pageId,
    workspaceId: "10000000-0000-4000-8000-000000000001",
    parentId: null,
    slug: "knowledge",
    title: "Knowledge",
    bodyMd: "",
    revision: 1,
    contentHash: "0".repeat(64),
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
const tree: PageTreeNode[] = [{
  id: parentId,
  parentId: null,
  slug: "parent",
  title: "Parent",
  accessMode: "workspace",
  updatedAt: "2026-08-18T00:00:00.000Z",
  children: [{
    id: pageId,
    parentId,
    slug: "knowledge",
    title: "Knowledge",
    accessMode: "workspace",
    updatedAt: "2026-08-18T00:00:00.000Z",
    children: [],
  }],
}, {
  id: destinationId,
  parentId: null,
  slug: "destination",
  title: "Destination",
  accessMode: "workspace",
  updatedAt: "2026-08-18T00:00:00.000Z",
  children: [],
}];

describe("KnowledgeOrganizerDrawer", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("restores an eligible trash root", async () => {
    const getTrashedPages = vi.fn(() => Promise.resolve([{
      id: pageId,
      parentId: null,
      slug: "knowledge",
      title: "Knowledge",
      accessMode: "workspace" as const,
      updatedAt: "2026-08-18T00:00:00.000Z",
      trashedAt: "2026-08-18T01:00:00.000Z",
      restorable: true,
    }]));
    const restorePage = vi.fn(() => Promise.resolve(page));
    const onRestored = vi.fn();
    view = await renderDrawer("trash", { getTrashedPages, restorePage }, { onRestored });
    await flushUi();
    const restore = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "復元");
    if (!restore) throw new Error("Restore button was not rendered");

    act(() => { restore.click(); });
    await flushUi();

    expect(restorePage).toHaveBeenCalledWith(pageId);
    expect(onRestored).toHaveBeenCalledWith(page);
  });

  it("edits normalized page tags", async () => {
    const tags = [{ id: "40000000-0000-4000-8000-000000000001", name: "Cloudflare" }];
    const replacePageTags = vi.fn(() => Promise.resolve(tags));
    const onTagsChanged = vi.fn();
    view = await renderDrawer("tags", { replacePageTags }, { onTagsChanged });
    const input = view.container.querySelector<HTMLTextAreaElement>("#page-tags");
    if (!input) throw new Error("Tag editor was not rendered");
    setInputValue(input, "Cloudflare, AI, Cloudflare");

    act(() => { view?.container.querySelector<HTMLFormElement>("form")?.requestSubmit(); });
    await flushUi();

    expect(replacePageTags).toHaveBeenCalledWith(pageId, ["Cloudflare", "AI"], expect.any(AbortSignal));
    expect(onTagsChanged).toHaveBeenCalledWith(tags);
  });

  it("provides a keyboard-operable alternative to tree dragging", async () => {
    const moved = { ...page, page: { ...page.page, parentId: destinationId } };
    const movePage = vi.fn(() => Promise.resolve(moved));
    const onMoved = vi.fn();
    view = await renderDrawer("move", { movePage }, { onMoved });
    const destination = view.container.querySelector<HTMLSelectElement>("#move-parent");
    if (!destination) throw new Error("Move destination was not rendered");
    act(() => {
      destination.value = destinationId;
      destination.dispatchEvent(new Event("change", { bubbles: true }));
      view?.container.querySelector<HTMLFormElement>("form")?.requestSubmit();
    });
    await flushUi();

    expect(movePage).toHaveBeenCalledWith(pageId, { parentId: destinationId }, expect.any(AbortSignal));
    expect(onMoved).toHaveBeenCalledWith(moved);
  });
});

function renderDrawer(
  mode: KnowledgeOrganizerMode,
  apiMethods: Partial<WikiApi>,
  callbacks: Partial<{
    onMoved: (resource: PageResource) => void;
    onRestored: (resource: PageResource) => void;
    onTagsChanged: (tags: PageResource["tags"]) => void;
  }> = {},
): Promise<RenderedView> {
  return renderView(
    <KnowledgeOrganizerDrawer
      api={apiMethods as WikiApi}
      mode={mode}
      onMoved={callbacks.onMoved ?? (() => undefined)}
      onRestored={callbacks.onRestored ?? (() => undefined)}
      onSelectPage={() => undefined}
      onTagsChanged={callbacks.onTagsChanged ?? (() => undefined)}
      pageId={pageId}
      pageTags={[]}
      tree={tree}
    />,
  );
}
