import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpUrl,
  fetchPublicDocument,
} from "../../src/imports/public-url";

describe("public URL import security", () => {
  it.each([
    "file:///etc/passwd",
    "https://user:password@example.com/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.2.3/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "https://service.internal/path",
  ])("rejects non-public target %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });

  it("accepts a normal public HTTPS target", () => {
    expect(assertPublicHttpUrl("https://example.com/notes#section").toString()).toBe(
      "https://example.com/notes",
    );
  });

  it("revalidates a redirect before performing another fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/secrets" },
      })),
    );
    await expect(
      fetchPublicDocument("https://example.com/start", fetcher),
    ).rejects.toThrow("not publicly routable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses before buffering them", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("ignored", {
        headers: {
          "Content-Length": String(21 * 1024 * 1024),
          "Content-Type": "application/pdf",
        },
      })),
    );
    await expect(
      fetchPublicDocument("https://example.com/large.pdf", fetcher),
    ).rejects.toThrow("20 MiB");
  });

  it("returns a bounded supported document after a safe redirect", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      return Promise.resolve(url.endsWith("/start")
        ? new Response(null, {
            status: 301,
            headers: { Location: "/article" },
          })
        : new Response("<h1>Knowledge</h1>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }));
    });
    const result = await fetchPublicDocument(
      "https://example.com/start",
      fetcher,
    );
    expect(new TextDecoder().decode(result.bytes)).toBe("<h1>Knowledge</h1>");
    expect(result).toMatchObject({
      contentType: "text/html",
      filename: "article",
      finalUrl: "https://example.com/article",
    });
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}
