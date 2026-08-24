import { z } from "zod";

import { GoogleTokenVault, type GoogleToken } from "./token-vault";

const MAX_GOOGLE_DOCUMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

export class GoogleRetriableError extends Error {
  public constructor(message: string, public readonly retryAfterMs: number) {
    super(message);
    this.name = "GoogleRetriableError";
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export interface GoogleImportEnvironment {
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_PICKER_API_KEY: string;
  GOOGLE_CLOUD_PROJECT_NUMBER: string;
  TOKEN_ENCRYPTION_KEY: string;
}

export async function exchangeGoogleAuthorizationCode(
  environment: GoogleImportEnvironment,
  userId: string,
  expectedEmail: string,
  code: string,
  redirectUri: string,
): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: environment.GOOGLE_CLIENT_ID,
      client_secret: environment.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  assertGoogleResponse(response, "Google authorization");
  const value = tokenResponseSchema.parse(await response.json());
  const identityResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${value.access_token}` } },
  );
  assertGoogleResponse(identityResponse, "Google identity lookup");
  const identity = z
    .object({ email: z.email(), email_verified: z.boolean() })
    .parse(await identityResponse.json());
  if (
    !identity.email_verified ||
    !googleEmailsMatch(identity.email, expectedEmail)
  ) {
    throw new Error("Google import account must match the active wiki member email");
  }
  const vault = tokenVault(environment);
  const previous = await vault.get(userId);
  await vault.put(userId, {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + value.expires_in * 1_000,
    scope: value.scope,
  });
}

export async function fetchGoogleDocument(
  environment: GoogleImportEnvironment,
  userId: string,
  documentId: string,
): Promise<unknown> {
  const accessToken = await getGoogleAccessToken(environment, userId);
  const url = new URL(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
  );
  url.searchParams.set("includeTabsContent", "true");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new GoogleRetriableError(
      "Google Docs request could not be completed",
      DEFAULT_RETRY_DELAY_MS,
    );
  }
  assertGoogleResponse(response, "Google Docs fetch");
  return readBoundedGoogleJson(response, MAX_GOOGLE_DOCUMENT_BYTES);
}

export async function getGoogleAccessToken(
  environment: GoogleImportEnvironment,
  userId: string,
): Promise<string> {
  const vault = tokenVault(environment);
  const stored = await vault.get(userId);
  if (stored === null) throw new Error("Google import is not connected for this user");
  if (stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
  if (stored.refreshToken === undefined) {
    throw new Error("Google authorization expired and cannot be refreshed");
  }
  const refreshed = await refreshAccessToken(environment, stored);
  await vault.put(userId, refreshed);
  return refreshed.accessToken;
}

async function refreshAccessToken(
  environment: GoogleImportEnvironment,
  stored: GoogleToken,
): Promise<GoogleToken> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refreshToken ?? "",
      client_id: environment.GOOGLE_CLIENT_ID,
      client_secret: environment.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  assertGoogleResponse(response, "Google token refresh");
  const value = tokenResponseSchema.parse(await response.json());
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + value.expires_in * 1_000,
    scope: value.scope ?? stored.scope,
  };
}

function tokenVault(environment: GoogleImportEnvironment): GoogleTokenVault {
  return new GoogleTokenVault(environment.OAUTH_KV, environment.TOKEN_ENCRYPTION_KEY);
}

export async function readBoundedGoogleJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Google document exceeds the 20 MiB import limit");
  }
  if (response.body === null) {
    throw new GoogleRetriableError(
      "Google Docs returned an empty response body",
      DEFAULT_RETRY_DELAY_MS,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      received += result.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error("Google document exceeds the 20 MiB import limit");
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } catch (error) {
    if (error instanceof GoogleRetriableError || isImportLimitError(error)) throw error;
    throw new GoogleRetriableError(
      "Google Docs response was interrupted",
      DEFAULT_RETRY_DELAY_MS,
    );
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && declaredLength !== received) {
    throw new GoogleRetriableError(
      "Google Docs response length did not match Content-Length",
      DEFAULT_RETRY_DELAY_MS,
    );
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Google Docs returned invalid JSON");
  }
}

export function googleRetryDelay(error: Error): number {
  return error instanceof GoogleRetriableError
    ? error.retryAfterMs
    : DEFAULT_RETRY_DELAY_MS;
}

function assertGoogleResponse(response: Response, operation: string): void {
  if (response.ok) return;
  if (response.status === 429 || response.status >= 500) {
    throw new GoogleRetriableError(
      `${operation} temporarily failed with status ${String(response.status)}`,
      retryAfterMilliseconds(response.headers.get("retry-after")),
    );
  }
  throw new Error(`${operation} failed with status ${String(response.status)}`);
}

function retryAfterMilliseconds(value: string | null): number {
  if (value !== null && /^\d{1,7}$/u.test(value.trim())) {
    return clampRetryDelay(Number(value.trim()) * 1_000);
  }
  if (value !== null) {
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) return clampRetryDelay(retryAt - Date.now());
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function clampRetryDelay(value: number): number {
  return Math.max(1_000, Math.min(MAX_RETRY_DELAY_MS, value));
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d{1,12}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isImportLimitError(error: unknown): boolean {
  return error instanceof Error && error.message === "Google document exceeds the 20 MiB import limit";
}

export function googleEmailsMatch(left: string, right: string): boolean {
  return normalizeEmail(left) === normalizeEmail(right);
}

function normalizeEmail(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
