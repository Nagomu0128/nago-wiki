import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, HttpWikiApi } from "./client";

describe("HttpWikiApi", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("preserves the API error code and request id", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: "PAGE_NOT_FOUND", message: "Not visible", requestId: "req-hidden" },
    }), { status: 404, headers: { "content-type": "application/json" } }))));

    const api = new HttpWikiApi("https://wiki.example/api/v1");
    const error = await api.getPage("missing").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ status: 404, code: "PAGE_NOT_FOUND", requestId: "req-hidden" });
  });

  it("does not fall back to fixtures after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    const api = new HttpWikiApi();

    await expect(api.getTree()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });

  it("uses scoped organization endpoints for favorites, tags, and backlinks", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ favorite: true }))
      .mockResolvedValueOnce(Response.json({ tags: [{ id: "40000000-0000-4000-8000-000000000001", name: "AI" }] }))
      .mockResolvedValueOnce(Response.json({ pages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpWikiApi("https://wiki.example/api/v1");

    await api.setFavorite("page/one", true);
    await api.replacePageTags("page/one", ["AI"]);
    await api.getBacklinks("page/one");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://wiki.example/api/v1/pages/page%2Fone/favorite", expect.objectContaining({ method: "PUT" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://wiki.example/api/v1/pages/page%2Fone/tags", expect.objectContaining({ method: "PUT", body: JSON.stringify({ names: ["AI"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://wiki.example/api/v1/pages/page%2Fone/backlinks", expect.any(Object));
  });
});
