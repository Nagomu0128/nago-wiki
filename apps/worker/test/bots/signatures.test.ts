import { describe, expect, it } from "vitest";

import {
  hmacHex,
  verifyBridgeSignature,
  verifyLineSignature,
} from "../../src/bots/signatures";

describe("bot request signatures", () => {
  it("verifies LINE HMAC signatures", async () => {
    const body = '{"events":[]}';
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("line-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCodePoint(byte);
    const signature = btoa(binary);
    await expect(verifyLineSignature(body, signature, "line-secret")).resolves.toBe(true);
    await expect(verifyLineSignature(`${body}x`, signature, "line-secret")).resolves.toBe(false);
  });

  it("rejects stale Discord bridge requests", async () => {
    const timestamp = String(Math.floor(Date.now() / 1_000) - 601);
    const signature = await hmacHex(`${timestamp}.hello`, "bridge-secret");
    await expect(
      verifyBridgeSignature("hello", timestamp, signature, "bridge-secret"),
    ).resolves.toBe(false);
  });
});
