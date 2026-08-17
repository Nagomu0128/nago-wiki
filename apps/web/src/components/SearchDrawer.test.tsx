// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiFailure, type WikiApi } from "../api";
import { flushUi, renderView, setInputValue, type RenderedView } from "../test/render";
import { SearchDrawer } from "./SearchDrawer";

const api = {
  search() { return Promise.reject(new ApiFailure(503, "SEARCH_UNAVAILABLE", "検索基盤が一時停止しています。", "req-search")); },
} as unknown as WikiApi;

const ignoreMode = (value: string) => value.length > 0;
const ignorePage = (value: string) => value.length > 0;

describe("SearchDrawer", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("shows an actionable API error instead of an empty result", async () => {
    view = await renderView(<SearchDrawer api={api} mode="search" onModeChange={ignoreMode} onSelectPage={ignorePage} />);
    const query = view.container.querySelector<HTMLTextAreaElement>("#workspace-search");
    if (!query) throw new Error("Search input was not rendered");
    setInputValue(query, "Cloudflare");
    const submit = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "検索" && !button.hasAttribute("role"));
    act(() => { submit?.click(); });
    await flushUi();

    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("検索基盤が一時停止しています。");
    expect(view.container.textContent).toContain("req-search");
  });
});
