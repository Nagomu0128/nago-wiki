// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { WikiApi } from "./api";
import { App } from "./App";
import type { RealtimeProviderFactory } from "./realtime";
import { flushUi, renderView, type RenderedView } from "./test/render";

const api = {
  getMe() {
    return Promise.resolve({
      user: { id: "user", displayName: "Nagomu", email: "nagomu@example.com", role: "owner" as const },
      workspace: { id: "workspace", name: "Nago Wiki" },
      features: { aiAnswer: true, googleImport: true, realtime: true },
      budget: { state: "normal" as const, usedPercent: 10 },
    });
  },
  getTree() { return Promise.resolve([]); },
  getFavoritePages() { return Promise.resolve([]); },
} as unknown as WikiApi;

const unusedRealtime = {} as RealtimeProviderFactory;

describe("workspace keyboard navigation", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("focuses global search with Ctrl+K", async () => {
    view = await renderView(<App api={api} realtimeFactory={unusedRealtime} />);
    await flushUi();

    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
    await flushUi();

    expect(document.activeElement).toBe(view.container.querySelector("#workspace-search"));
  });

  it("removes a closed utility drawer from the tab and accessibility trees", async () => {
    view = await renderView(<App api={api} realtimeFactory={unusedRealtime} />);
    const close = view.container.querySelector<HTMLButtonElement>("aside[aria-label='検索とAI'] button[aria-label='パネルを閉じる']");
    if (!close) throw new Error("Drawer close button was not rendered");

    act(() => { close.click(); });
    await flushUi();

    expect(view.container.querySelector("aside[aria-label='検索とAI']")).toBeNull();
    expect(view.container.querySelector("#workspace-search")).toBeNull();
  });
});
