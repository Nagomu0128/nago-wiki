export async function verifyLineSignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (signature === null || signature.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return constantTimeEqual(toBase64(new Uint8Array(digest)), signature);
}

export async function verifyBridgeSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (timestamp === null || signature === null) return false;
  const timestampMilliseconds = Number(timestamp) * 1_000;
  if (
    !Number.isFinite(timestampMilliseconds) ||
    Math.abs(now - timestampMilliseconds) > 5 * 60 * 1_000
  ) {
    return false;
  }
  const expected = await hmacHex(`${timestamp}.${body}`, secret);
  return constantTimeEqual(expected, signature.toLowerCase());
}

export async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary);
}
