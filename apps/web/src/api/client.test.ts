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
});
