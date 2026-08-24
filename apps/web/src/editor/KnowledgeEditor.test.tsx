// @vitest-environment happy-dom

import { forwardRef, useImperativeHandle, useRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevisionConflictFailure, type PageResource, type WikiApi } from "../api";
import type { RealtimeProviderFactory } from "../realtime";
import { flushUi, renderView, setInputValue, type RenderedView } from "../test/render";
import { KnowledgeEditor, type CrepeSurfaceProps, type EditorSurfaceHandle } from "./KnowledgeEditor";

const resource: PageResource = {
  page: {
    id: "30000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    parentId: null,
    slug: "test",
    title: "テストページ",
    bodyMd: "# テスト\n\n本文",
    revision: 3,
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

const TestSurface = forwardRef<EditorSurfaceHandle, CrepeSurfaceProps>(function TestSurface({ initialMarkdown }, ref) {
  const markdownRef = useRef(initialMarkdown);
  useImperativeHandle(ref, () => ({
    getMarkdown: () => markdownRef.current,
    setMarkdown: (markdown) => { markdownRef.current = markdown; },
  }), []);
  return <div aria-label="test visual editor">{markdownRef.current}</div>;
});

const realtimeFactory: RealtimeProviderFactory = {
  connect({ document, permission }) {
    return {
      document,
      status: "connected",
      permission,
      subscribeStatus(listener) { listener("connected"); return () => permission.length > 0; },
      subscribePermission(listener) { listener(permission); return () => permission.length > 0; },
      destroy() { document.destroy(); },
    };
  },
};

function apiWithUpdate(updatePage: WikiApi["updatePage"], getPage: WikiApi["getPage"] = vi.fn(() => Promise.resolve(resource))) {
  return { getPage, updatePage } as unknown as WikiApi;
}

describe("KnowledgeEditor", () => {
  let view: RenderedView | undefined;
  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.useRealTimers();
  });

  it("toggles to Markdown source without losing the canonical content", async () => {
    const api = apiWithUpdate(vi.fn(() => Promise.resolve(resource)));
    view = await renderView(<KnowledgeEditor api={api} realtimeFactory={realtimeFactory} resource={resource} surfaceComponent={TestSurface} />);
    const markdownButton = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Markdown");

    act(() => { markdownButton?.click(); });

    const source = view.container.querySelector<HTMLTextAreaElement>("[aria-label='Markdownソース']");
    expect(source?.value).toBe(resource.page.bodyMd);
    if (!source) throw new Error("Markdown source was not rendered");
    setInputValue(source, "# 更新\n\n新しい本文");
    const visualButton = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "ビジュアル");
    act(() => { visualButton?.click(); });
    expect(view.container.querySelector("[aria-label='Markdownソース']")).toBeNull();
  });

  it("keeps editing locked until the first realtime synchronization", async () => {
    const connectingFactory: RealtimeProviderFactory = {
      connect({ document, permission }) {
        return {
          document,
          status: "connecting",
          permission,
          subscribeStatus(listener) {
            listener("connecting");
            return () => undefined;
          },
          subscribePermission(listener) {
            listener(permission);
            return () => undefined;
          },
          destroy() {
            document.destroy();
          },
        };
      },
    };
    view = await renderView(
      <KnowledgeEditor
        api={apiWithUpdate(vi.fn(() => Promise.resolve(resource)))}
        realtimeFactory={connectingFactory}
        resource={resource}
        surfaceComponent={TestSurface}
      />,
    );

    expect(
      view.container.querySelector<HTMLInputElement>("[aria-label='ページタイトル']")
        ?.disabled,
    ).toBe(true);
    expect(view.container.textContent).toContain("接続後に編集できます");
  });

  it("keeps local content and opens conflict resolution on a stale baseRevision", async () => {
    vi.useFakeTimers();
    const latest: PageResource = { ...resource, page: { ...resource.page, revision: 4, bodyMd: "# サーバー版" } };
    const getPage = vi.fn(() => Promise.resolve(latest));
    const api = apiWithUpdate(
      vi.fn(() => Promise.reject(new RevisionConflictFailure("stale", "req-conflict"))),
      getPage,
    );
    view = await renderView(<KnowledgeEditor api={api} realtimeFactory={realtimeFactory} resource={resource} surfaceComponent={TestSurface} />);
    const title = view.container.querySelector<HTMLInputElement>("[aria-label='ページタイトル']");
    if (!title) throw new Error("Title input was not rendered");
    title.focus();
    setInputValue(title, "ローカルのタイトル");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(view.container.querySelector("[role='dialog']")?.textContent).toContain("別の編集が先に保存されました");
    expect(view.container.textContent).toContain("rev. 4");
    expect(getPage).toHaveBeenCalledWith(resource.page.id);
    const loadLatest = [...view.container.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")]
      .find((button) => button.textContent === "最新版を読み込む");
    expect(document.activeElement).toBe(loadLatest);
    act(() => { loadLatest?.click(); });
    expect(view.container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(title);
  });

  it("reports move and trash results so the shell can refresh navigation", async () => {
    const moved = { ...resource, page: { ...resource.page, parentId: null, revision: 4 } };
    const movePage = vi.fn(() => Promise.resolve(moved));
    const trashPage = vi.fn(() => Promise.resolve({ status: "trashed" as const, pageIds: [resource.page.id] }));
    const onMoved = vi.fn();
    const onTrashed = vi.fn();
    const api = { ...apiWithUpdate(vi.fn(() => Promise.resolve(resource))), movePage, trashPage } as unknown as WikiApi;
    view = await renderView(
      <KnowledgeEditor
        api={api}
        onMoved={onMoved}
        onTrashed={onTrashed}
        realtimeFactory={realtimeFactory}
        resource={resource}
        surfaceComponent={TestSurface}
      />,
    );
    const buttons = [...view.container.querySelectorAll("button")];

    await act(async () => {
      buttons.find((button) => button.textContent === "ルートへ移動")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons.find((button) => button.textContent === "ゴミ箱へ移動")?.click();
      await Promise.resolve();
    });

    expect(onMoved).toHaveBeenCalledWith(moved);
    expect(onTrashed).toHaveBeenCalledWith([resource.page.id]);
  });

  it("creates a page from a broken Wiki link and inserts the resolved link", async () => {
    const created: PageResource = {
      ...resource,
      page: {
        ...resource.page,
        id: "30000000-0000-4000-8000-000000000099",
        slug: "new-note",
        title: "New note",
      },
    };
    const createPage = vi.fn(() => Promise.resolve(created));
    const onPageCreated = vi.fn();
    const api = {
      ...apiWithUpdate(vi.fn(() => Promise.resolve(resource))),
      createPage,
    } as unknown as WikiApi;
    view = await renderView(
      <KnowledgeEditor
        api={api}
        onPageCreated={onPageCreated}
        realtimeFactory={realtimeFactory}
        resource={resource}
        suggestionProvider={{ search: () => Promise.resolve([]) }}
        surfaceComponent={TestSurface}
      />,
    );
    act(() => {
      [...view?.container.querySelectorAll("button") ?? []]
        .find((button) => button.textContent === "Markdown")?.click();
    });
    const source = view.container.querySelector<HTMLTextAreaElement>("[aria-label='Markdownソース']");
    if (!source) throw new Error("Markdown source was not rendered");
    source.focus();
    setInputValue(source, "See [[New note");
    await flushUi();
    const create = [...view.container.querySelectorAll<HTMLButtonElement>("[role='option']")]
      .find((button) => button.textContent.includes("新規作成"));
    if (!create) throw new Error("Broken-link create option was not rendered");

    act(() => { create.click(); });
    await flushUi();

    expect(createPage).toHaveBeenCalledWith({ parentId: null, title: "New note" });
    expect(onPageCreated).toHaveBeenCalledWith(created);
    expect(source.value).toContain("[[New note]]");
  });
});
