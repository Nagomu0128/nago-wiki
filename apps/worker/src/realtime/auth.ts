import {
  isRealtimePermission,
  type RealtimeAuthorization,
  type RealtimePermission,
} from "./types";

const TOKEN_VERSION = "v1";
const MAX_CLOCK_SKEW_MS = 30_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(padded + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error("Realtime internal secret must contain at least 32 characters");
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signRealtimeAuthorization(
  authorization: RealtimeAuthorization,
  secret: string,
): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify(authorization)),
  );
  const signingInput = `${TOKEN_VERSION}.${payload}`;
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyRealtimeAuthorization(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<RealtimeAuthorization | null> {
  const [version, payload, signature, extra] = token.split(".");
  if (
    version !== TOKEN_VERSION ||
    payload === undefined ||
    signature === undefined ||
    extra !== undefined
  ) {
    return null;
  }

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    asArrayBuffer(fromBase64Url(signature)),
    new TextEncoder().encode(`${version}.${payload}`),
  );
  if (!valid) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }

  if (!isAuthorization(parsed)) {
    return null;
  }
  if (parsed.issuedAt > now + MAX_CLOCK_SKEW_MS || parsed.expiresAt <= now) {
    return null;
  }

  return parsed;
}

function isAuthorization(value: unknown): value is RealtimeAuthorization {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RealtimeAuthorization>;
  return (
    isNonEmptyString(candidate.workspaceId) &&
    isNonEmptyString(candidate.pageId) &&
    isNonEmptyString(candidate.userId) &&
    isNonEmptyString(candidate.sessionId) &&
    isRealtimePermission(candidate.permission) &&
    isFiniteTimestamp(candidate.expiresAt) &&
    isFiniteTimestamp(candidate.issuedAt)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type PermissionTransition =
  | { action: "close" }
  | { action: "keep"; permission: RealtimePermission };

export function permissionTransition(
  nextPermission: RealtimePermission | null,
): PermissionTransition {
  return nextPermission === null
    ? { action: "close" }
    : { action: "keep", permission: nextPermission };
}
