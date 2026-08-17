import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { McpApiHandler } from "./handler";
import { escapeHtml } from "./security";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

const authorizationRequestSchema = z.object({
  responseType: z.string(),
  clientId: z.string(),
  redirectUri: z.url(),
  scope: z.array(z.string()),
  state: z.string(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.string().optional(),
  resource: z.union([z.string(), z.array(z.string())]).optional(),
  issuer: z.string().optional(),
});

const pendingConsentSchema = z.object({
  request: authorizationRequestSchema,
  clientName: z.string(),
  csrf: z.string(),
});

const googleStateSchema = z.object({
  request: authorizationRequestSchema,
  clientName: z.string(),
});

const googleTokenSchema = z.object({ access_token: z.string().min(1) });
const googleUserSchema = z.object({
  email: z.email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
});

interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
}

const consentCookie = "__Host-MCP_CONSENT";
const stateCookie = "__Host-MCP_GOOGLE_STATE";

export class McpAuthorizationHandler extends WorkerEntrypoint<McpRuntimeEnv> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") {
      return this.showConsent(request);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      return this.acceptConsent(request);
    }
    if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
      return this.finishGoogleAuthorization(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private async showConsent(request: Request): Promise<Response> {
    let authRequest: AuthRequest;
    try {
      authRequest = await this.env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      return authorizationErrorResponse(error);
    }
    const client = await this.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    if (client === null) {
      return new Response("Unknown OAuth client", { status: 400 });
    }

    const flowId = crypto.randomUUID();
    const csrf = crypto.randomUUID();
    const pending = pendingConsentSchema.parse({
      request: authRequest,
      clientName: client.clientName ?? "Unknown MCP client",
      csrf,
    });
    await this.env.OAUTH_KV.put(`mcp:consent:${flowId}`, JSON.stringify(pending), {
      expirationTtl: 600,
    });

    const html = renderConsent(pending.clientName, pending.request.scope, flowId, csrf);
    return new Response(html, {
      headers: securityHeaders(
        `${consentCookie}=${flowId}.${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      ),
    });
  }

  private async acceptConsent(request: Request): Promise<Response> {
    const form = await request.formData();
    const flowId = requiredFormString(form, "flow_id");
    const csrf = requiredFormString(form, "csrf_token");
    const action = requiredFormString(form, "action");
    const cookie = readCookie(request, consentCookie);
    if (cookie !== `${flowId}.${csrf}`) {
      return new Response("Invalid or expired consent session", { status: 400 });
    }

    const stored = await this.env.OAUTH_KV.get(`mcp:consent:${flowId}`);
    await this.env.OAUTH_KV.delete(`mcp:consent:${flowId}`);
    const pending = pendingConsentSchema.safeParse(parseJson(stored));
    if (!pending.success || pending.data.csrf !== csrf) {
      return new Response("Invalid or expired consent session", { status: 400 });
    }
    if (action !== "approve") {
      return denyAuthorization(toAuthRequest(pending.data.request));
    }

    const state = crypto.randomUUID();
    await this.env.OAUTH_KV.put(
      `mcp:google-state:${state}`,
      JSON.stringify({
        request: pending.data.request,
        clientName: pending.data.clientName,
      }),
      { expirationTtl: 600 },
    );
    const stateHash = await sha256(state);
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", this.env.GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set("redirect_uri", googleRedirectUri(this.env));
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("prompt", "select_account");

    return new Response(null, {
      status: 302,
      headers: {
        location: googleUrl.toString(),
        "set-cookie": `${stateCookie}=${stateHash}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      },
    });
  }

  private async finishGoogleAuthorization(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (
      state === null ||
      code === null ||
      readCookie(request, stateCookie) !== (await sha256(state))
    ) {
      return new Response("Invalid Google OAuth callback", { status: 400 });
    }

    const stored = await this.env.OAUTH_KV.get(`mcp:google-state:${state}`);
    await this.env.OAUTH_KV.delete(`mcp:google-state:${state}`);
    const pending = googleStateSchema.safeParse(parseJson(stored));
    if (!pending.success) {
      return new Response("Expired Google OAuth callback", { status: 400 });
    }

    const googleUser = await fetchGoogleUser(this.env, code);
    if (!googleUser.email_verified) {
      return new Response("A verified Google email is required", { status: 403 });
    }
    const member = await this.env.DB.prepare(
      `SELECT id, workspace_id, email, display_name, role
         FROM users
        WHERE lower(email) = lower(?1)
          AND workspace_id = ?2
          AND status = 'active'`,
    )
      .bind(googleUser.email, this.env.WORKSPACE_ID)
      .first<UserRow>();
    if (member === null) {
      return new Response("This Google account is not an active wiki member", {
        status: 403,
      });
    }

    const grantedScopes = pending.data.request.scope.filter(
      (scope) => scope === "wiki:read",
    );
    const props: McpAuthProps = {
      userId: member.id,
      workspaceId: member.workspace_id,
      email: member.email,
      displayName: member.display_name,
      role: member.role,
      scopes: grantedScopes,
    };
    const { redirectTo } = await this.env.OAUTH_PROVIDER.completeAuthorization({
      request: toAuthRequest(pending.data.request),
      userId: member.id,
      metadata: { clientName: pending.data.clientName },
      scope: grantedScopes,
      props,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: redirectTo,
        "set-cookie": `${stateCookie}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
      },
    });
  }
}

export function createMcpOAuthProvider(environment: McpRuntimeEnv): OAuthProvider<McpRuntimeEnv> {
  const origin = new URL(environment.MCP_PUBLIC_ORIGIN).origin;
  return new OAuthProvider<McpRuntimeEnv>({
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler: McpAuthorizationHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["wiki:read"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2_592_000,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["wiki:read"],
      bearer_methods_supported: ["header"],
      resource_name: "Nago Wiki",
    },
    clientIdMetadataDocumentEnabled: true,
  });
}

async function fetchGoogleUser(
  environment: McpRuntimeEnv,
  code: string,
): Promise<z.infer<typeof googleUserSchema>> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: environment.GOOGLE_CLIENT_ID,
      client_secret: environment.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(environment),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Google token exchange failed with status ${String(tokenResponse.status)}`,
    );
  }
  const token = googleTokenSchema.parse(await tokenResponse.json());
  const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userResponse.ok) {
    throw new Error(`Google user lookup failed with status ${String(userResponse.status)}`);
  }
  return googleUserSchema.parse(await userResponse.json());
}

function googleRedirectUri(environment: McpRuntimeEnv): string {
  return new URL("/oauth/google/callback", environment.MCP_PUBLIC_ORIGIN).toString();
}

function renderConsent(
  clientName: string,
  scopes: string[],
  flowId: string,
  csrf: string,
): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Nago Wikiへの接続</title></head><body>
<main><h1>Nago Wikiへの接続</h1>
<p>${escapeHtml(clientName)} が次の権限を要求しています。</p>
<ul>${scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>
<form method="post" action="/authorize">
<input type="hidden" name="flow_id" value="${escapeHtml(flowId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<button type="submit" name="action" value="approve">Googleで認証して許可</button>
<button type="submit" name="action" value="deny">拒否</button>
</form></main></body></html>`;
}

function securityHeaders(setCookie: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "set-cookie": setCookie,
  };
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) {
    throw error;
  }
  if (error.redirectUri === undefined) {
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state !== undefined) redirect.searchParams.set("state", error.state);
  if (error.issuer !== undefined) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function denyAuthorization(request: AuthRequest): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The user denied access");
  redirect.searchParams.set("state", request.state);
  if (request.issuer !== undefined) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

function toAuthRequest(
  value: z.infer<typeof authorizationRequestSchema>,
): AuthRequest {
  const request: AuthRequest = {
    responseType: value.responseType,
    clientId: value.clientId,
    redirectUri: value.redirectUri,
    scope: value.scope,
    state: value.state,
  };
  if (value.codeChallenge !== undefined) request.codeChallenge = value.codeChallenge;
  if (value.codeChallengeMethod !== undefined) {
    request.codeChallengeMethod = value.codeChallengeMethod;
  }
  if (value.resource !== undefined) request.resource = value.resource;
  if (value.issuer !== undefined) request.issuer = value.issuer;
  return request;
}

function readCookie(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  const match = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return match?.slice(prefix.length) ?? null;
}

function requiredFormString(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing form field: ${name}`);
  }
  return value;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
