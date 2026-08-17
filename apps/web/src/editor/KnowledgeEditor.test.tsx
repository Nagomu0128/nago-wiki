// @vitest-environment happy-dom

import { forwardRef, useImperativeHandle, useRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevisionConflictFailure, type PageResource, type WikiApi } from "../api";
import type { RealtimeProviderFactory } from "../realtime";
import { renderView, setInputValue, type RenderedView } from "../test/render";
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
    setInputValue(title, "ローカルのタイトル");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(view.container.querySelector("[role='dialog']")?.textContent).toContain("別の編集が先に保存されました");
    expect(view.container.textContent).toContain("rev. 4");
    expect(getPage).toHaveBeenCalledWith(resource.page.id);
  });
});
