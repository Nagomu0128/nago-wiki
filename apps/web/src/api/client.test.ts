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

  it("maps the Google import request to the Worker contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: "import-1",
      sourceType: "google_docs",
      sourceLabel: "document-1",
      status: "queued",
      warnings: [],
      createdAt: "2026-08-23T00:00:00.000Z",
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpWikiApi("https://wiki.example/api/v1");

    await api.createImport({ sourceType: "google_docs", documentId: "document-1" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://wiki.example/api/v1/imports");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      source: { type: "google_docs", documentId: "document-1" },
    }));
  });

  it("encodes bot channel ids and sends owner control mutations", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpWikiApi("https://wiki.example/api/v1");

    await api.deleteBotChannel("discord", "team / private");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wiki.example/api/v1/admin/bot-channels/discord/team%20%2F%20private",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });
});
