import { describe, expect, it } from "vitest";
import { CloudflareAccessJwtVerifier } from "../src/auth/jwt";

describe("Cloudflare Access JWT verifier", () => {
  it("verifies the signature, issuer, audience, and expiry", async () => {
    const issuer = "https://team.cloudflareaccess.com";
    const audience = "access-audience";
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const publicJwk = {
      ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
      kid: "test-key",
      alg: "RS256",
    };
    const claims = {
      aud: audience,
      email: "member@example.com",
      exp: 2_000_000_000,
      iss: issuer,
      sub: "google-subject",
    };
    const token = await signJwt(keyPair.privateKey, claims);
    const fetcher = (() =>
      Promise.resolve(Response.json({ keys: [publicJwk] }))) as typeof fetch;
    const verifier = new CloudflareAccessJwtVerifier({
      audience,
      issuer,
      fetcher,
      now: () => 1_900_000_000_000,
    });

    await expect(verifier.verify(token)).resolves.toMatchObject({
      email: "member@example.com",
      sub: "google-subject",
    });
    const wrongAudienceVerifier = new CloudflareAccessJwtVerifier({
      audience: "another-audience",
      issuer,
      fetcher,
      now: () => 1_900_000_000_000,
    });
    await expect(wrongAudienceVerifier.verify(token)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      status: 401,
    });
  });
});

async function signJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const encodedHeader = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })),
  );
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken),
  );
  return `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
