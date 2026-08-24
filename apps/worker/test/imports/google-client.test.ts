import { describe, expect, it } from "vitest";

import {
  GoogleRetriableError,
  googleEmailsMatch,
  readBoundedGoogleJson,
} from "../../src/imports/google-client";

describe("bounded Google Docs responses", () => {
  it("matches the active member email case-insensitively", () => {
    expect(googleEmailsMatch("Member@Example.COM", "member@example.com")).toBe(true);
  });
  it("stops a chunked response with no Content-Length at the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedGoogleJson(new Response(body), 16)).rejects.toThrow(
      "20 MiB import limit",
    );
    expect(cancelled).toBe(true);
  });

  it("bounds the stream even when Content-Length is malformed", async () => {
    const response = new Response('{"title":"safe"}', {
      headers: { "content-length": "false" },
    });
    await expect(readBoundedGoogleJson(response, 100)).resolves.toEqual({
      title: "safe",
    });
  });

  it("treats a truncated declared response as retryable", async () => {
    const response = new Response("{}", {
      headers: { "content-length": "20" },
    });
    await expect(readBoundedGoogleJson(response, 100)).rejects.toBeInstanceOf(
      GoogleRetriableError,
    );
  });
});
