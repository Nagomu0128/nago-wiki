import { zValidator } from "@hono/zod-validator";
import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  exchangeGoogleAuthorizationCode,
  getGoogleAccessToken,
} from "./google-client";
import { GoogleTokenVault } from "./token-vault";
import type { ImportWorkflowParams } from "./workflow";
import { createRealtimeWikiCoreService } from "../core/realtime-mutations";
import { TagsService } from "../core/tags-service";
import type { McpRuntimeEnv } from "../mcp/types";

interface ImportApi {
  Bindings: McpRuntimeEnv;
  Variables: {
    identity: AuthenticatedIdentity | undefined;
    requestId: string | undefined;
    userId: string | undefined;
  };
}

interface MemberRow {
  id: string;
  email: string;
  role: "owner" | "editor" | "viewer";
}

interface ImportRow {
  id: string;
  workspace_id: string;
  user_id: string;
  source_type: string;
  source_metadata_json: string;
  status: string;
  report_r2_key: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

const googleStateSchema = z.object({
  userId: z.string(),
  expectedEmail: z.email(),
  returnTo: z.url(),
});

const createImportSchema = z.object({
  source: z.object({
    type: z.literal("google_docs"),
    documentId: z.string().min(1).max(256),
  }),
});

const applyImportSchema = z.object({
  parentId: z.uuid().nullable().optional().default(null),
  title: z.string().trim().min(1).max(500).optional(),
  accessMode: z.enum(["workspace", "restricted"]).optional().default("workspace"),
  acceptedTags: z.array(z.string().trim().min(1).max(100)).max(50).optional().default([]),
});

export function createImportRoutes(): Hono<ImportApi> {
  const routes = new Hono<ImportApi>();

  routes.get("/imports/google/authorize", async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    const userId = identity.id;
    const member = await requireEditor(
      context.env.DB,
      userId,
      identity.workspaceId,
    );
    const returnTo = safeReturnUrl(
      context.req.query("returnTo") ?? `${context.env.MCP_PUBLIC_ORIGIN}/imports`,
      context.env.MCP_PUBLIC_ORIGIN,
    );
    const state = crypto.randomUUID();
    await context.env.OAUTH_KV.put(
      `import:google-state:${state}`,
      JSON.stringify({ userId, expectedEmail: member.email, returnTo }),
      { expirationTtl: 600 },
    );

    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("client_id", context.env.GOOGLE_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", googleCallbackUrl(context.env));
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      "openid email https://www.googleapis.com/auth/drive.file",
    );
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent select_account");
    authorizationUrl.searchParams.set("state", state);
    return context.json({ authorizationUrl: authorizationUrl.toString() });
  });

  routes.get("/imports/google/callback", async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    if (state === undefined || code === undefined) {
      throw new HTTPException(400, { message: "Invalid Google OAuth callback" });
    }
    const stored = await context.env.OAUTH_KV.get(`import:google-state:${state}`);
    await context.env.OAUTH_KV.delete(`import:google-state:${state}`);
    const pending = googleStateSchema.safeParse(parseJson(stored));
    if (!pending.success) {
      throw new HTTPException(400, { message: "Expired Google OAuth callback" });
    }
    await exchangeGoogleAuthorizationCode(
      context.env,
      pending.data.userId,
      pending.data.expectedEmail,
      code,
      googleCallbackUrl(context.env),
    );
    const redirect = new URL(pending.data.returnTo);
    redirect.searchParams.set("google", "connected");
    return context.redirect(redirect.toString(), 302);
  });

  routes.get("/imports/google/picker-config", async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    await requireEditor(context.env.DB, identity.id, identity.workspaceId);
    const accessToken = await getGoogleAccessToken(context.env, identity.id);
    context.header("cache-control", "no-store, max-age=0");
    context.header("pragma", "no-cache");
    return context.json({
      accessToken,
      developerKey: context.env.GOOGLE_PICKER_API_KEY,
      appId: context.env.GOOGLE_CLOUD_PROJECT_NUMBER,
    });
  });

  routes.post("/imports", zValidator("json", createImportSchema), async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    const userId = identity.id;
    await requireEditor(context.env.DB, userId, identity.workspaceId);
    const vault = new GoogleTokenVault(
      context.env.OAUTH_KV,
      context.env.TOKEN_ENCRYPTION_KEY,
    );
    if ((await vault.get(userId)) === null) {
      throw new HTTPException(409, { message: "Connect Google before importing" });
    }
    const request = context.req.valid("json");
    const importId = crypto.randomUUID();
    const now = new Date().toISOString();
    await context.env.DB.prepare(
      `INSERT INTO imports (
         id, workspace_id, user_id, source_type, source_metadata_json,
         status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'google_docs', ?4, 'queued', ?5, ?5)`,
    )
      .bind(
        importId,
        identity.workspaceId,
        userId,
        JSON.stringify({ documentId: request.source.documentId }),
        now,
      )
      .run();

    const parameters: ImportWorkflowParams = {
      importId,
      workspaceId: identity.workspaceId,
      requestedBy: userId,
      source: request.source,
    };
    try {
      await context.env.IMPORT_WORKFLOW.create({
        id: `import-${importId}`,
        params: parameters,
        retention: { successRetention: "7 days", errorRetention: "30 days" },
      });
    } catch (error) {
      await context.env.DB.prepare(
        `UPDATE imports SET status = 'failed', updated_at = ?2 WHERE id = ?1`,
      )
        .bind(importId, new Date().toISOString())
        .run();
      throw error;
    }
    return context.json({
      id: importId,
      sourceType: "google_docs" as const,
      sourceLabel: request.source.documentId,
      status: "queued" as const,
      warnings: [],
      metadata: { documentId: request.source.documentId },
      createdAt: now,
      updatedAt: now,
    }, 202);
  });

  routes.get("/imports/:id", async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    const userId = identity.id;
    const member = await activeMember(
      context.env.DB,
      userId,
      identity.workspaceId,
    );
    const value = await context.env.DB.prepare(
      `SELECT id, workspace_id, user_id, source_type, source_metadata_json,
              status, report_r2_key, created_at, updated_at, expires_at
         FROM imports WHERE id = ?1`,
    )
      .bind(context.req.param("id"))
      .first<ImportRow>();
    if (value?.workspace_id !== identity.workspaceId) {
      throw new HTTPException(404, { message: "Import not found" });
    }
    if (value.user_id !== userId && member.role !== "owner") {
      throw new HTTPException(404, { message: "Import not found" });
    }
    const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
      parseJson(value.source_metadata_json),
    );
    const previewKey = typeof metadata.previewKey === "string" ? metadata.previewKey : null;
    const preview = previewKey === null ? null : await context.env.FILES.get(previewKey);
    const report = value.report_r2_key === null
      ? null
      : await readImportReport(context.env.FILES, value.report_r2_key);
    const title = typeof metadata.title === "string" ? metadata.title : undefined;
    const documentId = typeof metadata.documentId === "string" ? metadata.documentId : "Google Document";
    const errorMessage = typeof metadata.error === "string" ? metadata.error : undefined;
    return context.json({
      id: value.id,
      workspaceId: value.workspace_id,
      sourceType: value.source_type,
      sourceLabel: title ?? documentId,
      status: value.status,
      metadata,
      previewMarkdown: preview === null ? null : await preview.text(),
      warnings: report?.warnings ?? [],
      ...(title === undefined ? {} : { suggestedTitle: title }),
      ...(errorMessage === undefined
        ? {}
        : { error: { code: "IMPORT_FAILED", message: errorMessage } }),
      reportKey: value.report_r2_key,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      expiresAt: value.expires_at,
    });
  });

  routes.post(
    "/imports/:id/apply",
    zValidator("json", applyImportSchema),
    async (context) => {
      const identity = requireImportIdentity(context.get("identity"));
      await requireEditor(context.env.DB, identity.id, identity.workspaceId);
      const importId = context.req.param("id");
      const value = await context.env.DB.prepare(
        `SELECT id, workspace_id, user_id, source_type, source_metadata_json,
                status, report_r2_key, created_at, updated_at, expires_at
           FROM imports WHERE id = ?1`,
      )
        .bind(importId)
        .first<ImportRow>();
      if (value?.workspace_id !== identity.workspaceId) {
        throw new HTTPException(404, { message: "Import not found" });
      }
      if (value.user_id !== identity.id) {
        throw new HTTPException(404, { message: "Import not found" });
      }
      const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
        parseJson(value.source_metadata_json),
      );
      if (value.status === "applied" && typeof metadata.pageId === "string") {
        if (context.req.valid("json").acceptedTags.length > 0) {
          await new TagsService(context.env.DB).replacePageTags(
            identity,
            metadata.pageId,
            context.req.valid("json").acceptedTags,
          );
        }
        return context.json(await createRealtimeWikiCoreService(context.env).getPage(
          identity,
          metadata.pageId,
        ));
      }
      if (value.status !== "preview_ready") {
        throw new HTTPException(409, { message: "Import preview is not ready" });
      }
      if (value.expires_at !== null && value.expires_at <= new Date().toISOString()) {
        throw new HTTPException(410, { message: "Import preview has expired" });
      }
      const previewKey =
        typeof metadata.previewKey === "string" ? metadata.previewKey : null;
      if (previewKey === null) {
        throw new HTTPException(409, { message: "Import preview is unavailable" });
      }
      const preview = await context.env.FILES.get(previewKey);
      if (preview === null || preview.size > 1_048_576) {
        throw new HTTPException(409, { message: "Import preview is unavailable" });
      }
      const request = context.req.valid("json");
      const page = await createRealtimeWikiCoreService(context.env).createPage(
        identity,
        {
          parentId: request.parentId,
          title:
            request.title ??
            (typeof metadata.title === "string"
              ? metadata.title
              : "Imported Google Document"),
          bodyMd: await preview.text(),
          accessMode: request.accessMode,
        },
        `import:${importId}`,
      );
      if (request.acceptedTags.length > 0) {
        await new TagsService(context.env.DB).replacePageTags(
          identity,
          page.page.id,
          request.acceptedTags,
        );
      }
      await context.env.DB.prepare(
        `UPDATE imports
            SET status = 'applied',
                source_metadata_json = json_set(source_metadata_json, '$.pageId', ?2),
                updated_at = ?3
          WHERE id = ?1 AND status = 'preview_ready'`,
      )
        .bind(importId, page.page.id, new Date().toISOString())
        .run();
      return context.json(page, 201);
    },
  );

  return routes;
}

async function readImportReport(
  files: R2Bucket,
  key: string,
): Promise<{ warnings: string[] } | null> {
  const object = await files.get(key);
  if (object === null || object.size > 1_048_576) return null;
  try {
    const parsed = z.object({
      warnings: z.array(z.string().max(1_000)).max(100).default([]),
    }).safeParse(await object.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function requireEditor(
  database: D1Database,
  userId: string,
  workspaceId: string,
): Promise<MemberRow> {
  const member = await activeMember(database, userId, workspaceId);
  if (member.role === "viewer") {
    throw new HTTPException(403, { message: "Editor permission required" });
  }
  return member;
}

async function activeMember(
  database: D1Database,
  userId: string,
  workspaceId: string,
): Promise<MemberRow> {
  const member = await database
    .prepare(
      `SELECT id, email, role FROM users
        WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'`,
    )
    .bind(userId, workspaceId)
    .first<MemberRow>();
  if (member === null) throw new HTTPException(401, { message: "Authentication required" });
  return member;
}

function requireImportIdentity(
  identity: AuthenticatedIdentity | undefined,
): AuthenticatedIdentity {
  if (identity === undefined) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return identity;
}

function safeReturnUrl(value: string, publicOrigin: string): string {
  const result = new URL(value, publicOrigin);
  if (result.origin !== new URL(publicOrigin).origin) {
    throw new HTTPException(400, { message: "Invalid return URL" });
  }
  return result.toString();
}

function googleCallbackUrl(environment: McpRuntimeEnv): string {
  return new URL(
    "/api/v1/imports/google/callback",
    environment.MCP_PUBLIC_ORIGIN,
  ).toString();
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
