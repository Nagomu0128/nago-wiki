// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WikiApi } from "../api";
import { flushUi, renderView, type RenderedView } from "../test/render";
import { AccountLinkDrawer } from "./AccountLinkDrawer";

describe("AccountLinkDrawer", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("issues a provider-scoped one-time link command", async () => {
    const createAccountLink = vi.fn().mockResolvedValue({
      code: "one-time-code",
      expiresAt: "2026-08-18T12:10:00.000Z",
    });
    const api = { createAccountLink } as unknown as WikiApi;
    view = await renderView(<AccountLinkDrawer api={api} />);

    const line = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "LINE");
    if (!line) throw new Error("LINE selector was not rendered");
    act(() => { line.click(); });
    const issue = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent.includes("コードを発行"));
    if (!issue) throw new Error("Issue button was not rendered");
    act(() => { issue.click(); });
    await flushUi();

    expect(createAccountLink).toHaveBeenCalledWith("line", expect.any(AbortSignal));
    expect(view.container.textContent).toContain("link one-time-code");
  });
});
