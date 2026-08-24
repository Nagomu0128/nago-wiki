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
});
