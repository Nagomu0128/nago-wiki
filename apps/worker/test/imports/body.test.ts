import { describe, expect, it } from "vitest";

import { readBoundedImportJson } from "../../src/imports/body";

describe("readBoundedImportJson", () => {
  it("counts streamed bytes when Content-Length is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too long"}'));
        controller.close();
      },
    });
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      body: stream,
    });

    await expect(readBoundedImportJson(request, 10)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("does not trust a smaller declared Content-Length", async () => {
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      headers: { "Content-Length": "2" },
      body: '{"value":"larger"}',
    });

    await expect(readBoundedImportJson(request, 8)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("returns parsed JSON within the byte limit", async () => {
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      body: '{"sourceType":"paste","content":"memo"}',
    });

    await expect(readBoundedImportJson(request, 100)).resolves.toEqual({
      sourceType: "paste",
      content: "memo",
    });
  });

  it("accepts a request exactly at the byte limit", async () => {
    const payload = '{"value":"near-limit"}';
    const maxBytes = new TextEncoder().encode(payload).byteLength;
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      body: payload,
    });

    await expect(readBoundedImportJson(request, maxBytes)).resolves.toEqual({
      value: "near-limit",
    });
  });

  it("decodes a multibyte UTF-8 character split across stream chunks", async () => {
    const payload = new TextEncoder().encode('{"value":"猫"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, 11));
        controller.enqueue(payload.slice(11));
        controller.close();
      },
    });
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      body: stream,
    });

    await expect(readBoundedImportJson(request, payload.byteLength)).resolves.toEqual({
      value: "猫",
    });
  });

  it("rejects a request one byte over the streamed limit", async () => {
    const payload = '{"value":"over-limit"}';
    const byteLength = new TextEncoder().encode(payload).byteLength;
    const request = new Request("https://wiki.example/imports", {
      method: "POST",
      body: payload,
    });

    await expect(readBoundedImportJson(request, byteLength - 1)).rejects.toMatchObject({
      status: 413,
    });
  });
});
