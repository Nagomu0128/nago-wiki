import { describe, expect, it } from "vitest";

import { readBoundedText } from "../src/core/bounded-body";
import { ApiProblem } from "../src/core/errors";

describe("bounded request bodies", () => {
  it("rejects an oversized declared body before reading it", async () => {
    const request = new Request("https://wiki.example/webhook", {
      method: "POST",
      headers: { "content-length": "1025" },
      body: "small",
    });

    await expect(readBoundedText(request, 1024)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    } satisfies Partial<ApiProblem>);
  });

  it("cancels a chunked body as soon as it exceeds the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://wiki.example/webhook", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    await expect(readBoundedText(request, 1024)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    } satisfies Partial<ApiProblem>);
    expect(cancelled).toBe(true);
  });

  it("verifies Content-Length against the bytes received", async () => {
    const request = new Request("https://wiki.example/webhook", {
      method: "POST",
      headers: { "content-length": "10" },
      body: "short",
    });

    await expect(readBoundedText(request, 1024)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    } satisfies Partial<ApiProblem>);
  });

  it("rejects invalid UTF-8 instead of normalizing signed input", async () => {
    const request = new Request("https://wiki.example/webhook", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
    });

    await expect(readBoundedText(request, 1024)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    } satisfies Partial<ApiProblem>);
  });
});
