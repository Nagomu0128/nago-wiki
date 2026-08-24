import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../../src/mcp/pagination";

const encryptionKey = btoa("k".repeat(32))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/u, "");
const context = {
  userId: "user-1",
  workspaceId: "workspace-1",
  collection: "children" as const,
  targetPageId: "parent-1",
};

describe("MCP pagination cursors", () => {
  it("round-trips encrypted UTF-8 keyset cursors without exposing boundaries", async () => {
    const cursor = { sortTitle: "Restricted project", id: "secret-page-123" };
    const encoded = await encodeCursor(cursor, encryptionKey, context);

    await expect(
      decodeCursor(encoded, encryptionKey, context),
    ).resolves.toEqual(cursor);
    expect(encoded).not.toContain(cursor.sortTitle);
    expect(encoded).not.toContain(cursor.id);

    const decodedSegments = encoded
      .split(".")
      .slice(1)
      .map(decodeBase64Url)
      .join(" ");
    expect(decodedSegments).not.toContain(cursor.sortTitle);
    expect(decodedSegments).not.toContain(cursor.id);
  });

  it("rejects malformed, tampered, and context-replayed cursors", async () => {
    await expect(
      decodeCursor("not-an-envelope", encryptionKey, context),
    ).resolves.toBeNull();

    const encoded = await encodeCursor(
      { sortTitle: "Visible", id: "page-123" },
      encryptionKey,
      context,
    );
    const segments = encoded.split(".");
    const ciphertext = segments[2] ?? "";
    segments[2] = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
    await expect(
      decodeCursor(segments.join("."), encryptionKey, context),
    ).resolves.toBeNull();

    await expect(
      decodeCursor(encoded, encryptionKey, {
        ...context,
        collection: "backlinks",
      }),
    ).resolves.toBeNull();
    await expect(
      decodeCursor(encoded, encryptionKey, {
        ...context,
        userId: "other-user",
      }),
    ).resolves.toBeNull();

    const oversized = await encodeCursor(
      { sortTitle: "x".repeat(501), id: "page-123" },
      encryptionKey,
      context,
    );
    await expect(
      decodeCursor(oversized, encryptionKey, context),
    ).resolves.toBeNull();
  });
});

function decodeBase64Url(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
  );
}
