import { z } from "zod";

import { GoogleTokenVault, type GoogleToken } from "./token-vault";

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
  if (!response.ok) {
    throw new Error(`Google authorization failed with status ${String(response.status)}`);
  }
  const value = tokenResponseSchema.parse(await response.json());
  const identityResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${value.access_token}` } },
  );
  const identity = z
    .object({ email: z.email(), email_verified: z.boolean() })
    .parse(await identityResponse.json());
  if (!identityResponse.ok || !identity.email_verified || identity.email !== expectedEmail) {
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
  const accessToken = await validAccessToken(environment, userId);
  const url = new URL(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
  );
  url.searchParams.set("includeTabsContent", "true");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Docs fetch failed with status ${String(response.status)}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 20 * 1024 * 1024) {
    throw new Error("Google document exceeds the 20 MiB import limit");
  }
  return response.json();
}

async function validAccessToken(
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
  if (!response.ok) {
    throw new Error(`Google token refresh failed with status ${String(response.status)}`);
  }
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
