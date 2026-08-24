import { z } from "zod";

export const googleTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive(),
  scope: z.string().optional(),
});
export type GoogleToken = z.infer<typeof googleTokenSchema>;

export class GoogleTokenVault {
  public constructor(
    private readonly storage: KVNamespace,
    private readonly encodedKey: string,
  ) {}

  public async put(userId: string, token: GoogleToken): Promise<void> {
    const key = `import:google-token:${userId}`;
    const encrypted = await encryptJson(
      googleTokenSchema.parse(token),
      this.encodedKey,
      key,
    );
    await this.storage.put(key, encrypted);
  }

  public async get(userId: string): Promise<GoogleToken | null> {
    const key = `import:google-token:${userId}`;
    const encrypted = await this.storage.get(key);
    if (encrypted === null) return null;
    return googleTokenSchema.parse(await decryptJson(encrypted, this.encodedKey, key));
  }

  public delete(userId: string): Promise<void> {
    return this.storage.delete(`import:google-token:${userId}`);
  }
}

export async function encryptJson(
  value: unknown,
  encodedKey: string,
  associatedData: string,
): Promise<string> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(associatedData) },
    key,
    encoded,
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptJson(
  envelope: string,
  encodedKey: string,
  associatedData: string,
): Promise<unknown> {
  const [version, encodedIv, encodedCiphertext, extra] = envelope.split(".");
  if (
    version !== "v1" ||
    encodedIv === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unsupported encrypted token envelope");
  }
  const key = await importKey(encodedKey);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(encodedIv),
      additionalData: new TextEncoder().encode(associatedData),
    },
    key,
    fromBase64Url(encodedCiphertext),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function importKey(encodedKey: string): Promise<CryptoKey> {
  const raw = fromBase64Url(encodedKey);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}
