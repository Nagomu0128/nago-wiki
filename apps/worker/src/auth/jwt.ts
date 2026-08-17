import { ApiProblem } from "../core/errors";

const MAX_JWT_LENGTH = 16_384;
const MAX_JWKS_BYTES = 256_000;

export interface AccessJwtClaims {
  aud: string | string[];
  email: string;
  exp: number;
  iat?: number;
  iss: string;
  name?: string;
  nbf?: number;
  sub: string;
}

interface JwtHeader {
  alg: "RS256";
  kid: string;
  typ?: string;
}

export interface AccessJwtVerifier {
  verify(token: string): Promise<AccessJwtClaims>;
}

export interface CloudflareAccessJwtVerifierOptions {
  audience: string;
  issuer: string;
  jwksUrl?: string;
  clockSkewSeconds?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class CloudflareAccessJwtVerifier implements AccessJwtVerifier {
  readonly #audience: string;
  readonly #issuer: string;
  readonly #jwksUrl: string;
  readonly #clockSkewSeconds: number;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;

  public constructor(options: CloudflareAccessJwtVerifierOptions) {
    const issuerUrl = new URL(options.issuer);
    const jwksUrl = new URL(
      options.jwksUrl ?? `${issuerUrl.href.replace(/\/$/, "")}/cdn-cgi/access/certs`,
    );
    if (
      issuerUrl.protocol !== "https:" ||
      jwksUrl.protocol !== "https:" ||
      options.audience.trim().length === 0
    ) {
      throw new Error("Access JWT issuer must use HTTPS");
    }

    this.#audience = options.audience;
    this.#issuer = issuerUrl.href.replace(/\/$/, "");
    this.#jwksUrl = jwksUrl.href;
    this.#clockSkewSeconds = options.clockSkewSeconds ?? 60;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  public async verify(token: string): Promise<AccessJwtClaims> {
    if (token.length === 0 || token.length > MAX_JWT_LENGTH) {
      throw invalidJwt();
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw invalidJwt();
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw invalidJwt();
    }

    const header = parseHeader(decodeJson(encodedHeader));
    const claims = parseClaims(decodeJson(encodedPayload));
    const key = await this.#getSigningKey(header.kid);
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) {
      throw invalidJwt();
    }

    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (
      claims.iss.replace(/\/$/, "") !== this.#issuer ||
      !audienceIncludes(claims.aud, this.#audience) ||
      claims.exp <= nowSeconds - this.#clockSkewSeconds ||
      (claims.nbf !== undefined &&
        claims.nbf > nowSeconds + this.#clockSkewSeconds)
    ) {
      throw invalidJwt();
    }

    return claims;
  }

  async #getSigningKey(kid: string): Promise<CryptoKey> {
    const response = await this.#fetcher(this.#jwksUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new ApiProblem(
        "AUTH_CONFIGURATION_ERROR",
        503,
        "Authentication keys are temporarily unavailable",
      );
    }
    const contentLength = Number(response.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_JWKS_BYTES) {
      throw new ApiProblem(
        "AUTH_CONFIGURATION_ERROR",
        503,
        "Authentication keys response was invalid",
      );
    }

    const jwks = await readBoundedJson(response, MAX_JWKS_BYTES);
    if (!isJsonWebKeySet(jwks)) {
      throw new ApiProblem(
        "AUTH_CONFIGURATION_ERROR",
        503,
        "Authentication keys response was invalid",
      );
    }
    const jwk = jwks.keys.find((candidate) => candidate.kid === kid);
    if (jwk === undefined) {
      throw invalidJwt();
    }

    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (response.body === null) {
    throw invalidKeysResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw invalidKeysResponse();
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidKeysResponse();
  }
}

function invalidKeysResponse(): ApiProblem {
  return new ApiProblem(
    "AUTH_CONFIGURATION_ERROR",
    503,
    "Authentication keys response was invalid",
  );
}

function invalidJwt(): ApiProblem {
  return new ApiProblem(
    "AUTHENTICATION_REQUIRED",
    401,
    "A valid Cloudflare Access session is required",
  );
}

function decodeJson(encoded: string): unknown {
  try {
    const bytes = decodeBase64Url(encoded);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidJwt();
  }
}

function decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw invalidJwt();
  }
}

function parseHeader(value: unknown): JwtHeader {
  if (!isRecord(value) || value.alg !== "RS256" || typeof value.kid !== "string") {
    throw invalidJwt();
  }
  return {
    alg: "RS256",
    kid: value.kid,
    ...(typeof value.typ === "string" ? { typ: value.typ } : {}),
  };
}

function parseClaims(value: unknown): AccessJwtClaims {
  if (
    !isRecord(value) ||
    !(typeof value.aud === "string" || isStringArray(value.aud)) ||
    typeof value.email !== "string" ||
    typeof value.exp !== "number" ||
    typeof value.iss !== "string" ||
    typeof value.sub !== "string" ||
    (value.nbf !== undefined && typeof value.nbf !== "number") ||
    (value.iat !== undefined && typeof value.iat !== "number")
  ) {
    throw invalidJwt();
  }
  return {
    aud: value.aud,
    email: value.email,
    exp: value.exp,
    iss: value.iss,
    sub: value.sub,
    ...(typeof value.iat === "number" ? { iat: value.iat } : {}),
    ...(typeof value.nbf === "number" ? { nbf: value.nbf } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

function audienceIncludes(audience: string | string[], expected: string): boolean {
  return typeof audience === "string"
    ? audience === expected
    : audience.includes(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

interface JsonWebKeySet {
  keys: (JsonWebKey & { kid: string })[];
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  return (
    isRecord(value) &&
    Array.isArray(value.keys) &&
    value.keys.every(
      (key) => isRecord(key) && typeof key.kid === "string",
    )
  );
}
