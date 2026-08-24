import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "../../src/imports/token-vault";

const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("import token encryption", () => {
  it("round trips JSON while keeping plaintext out of the envelope", async () => {
    const encrypted = await encryptJson(
      { accessToken: "very-secret", expiresAt: 1_800_000_000 },
      key,
      "user:one",
    );
    expect(encrypted).not.toContain("very-secret");
    await expect(decryptJson(encrypted, key, "user:one")).resolves.toEqual({
      accessToken: "very-secret",
      expiresAt: 1_800_000_000,
    });
  });

  it("rejects ciphertext moved to another user record", async () => {
    const encrypted = await encryptJson({ token: "secret" }, key, "user:one");
    await expect(decryptJson(encrypted, key, "user:two")).rejects.toThrow();
  });
});
