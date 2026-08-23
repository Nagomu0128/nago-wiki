import { zValidator } from "@hono/zod-validator";
import {
  applyImportRequestSchema,
  type AuthenticatedIdentity,
  type ImportSourceType,
} from "@nago-wiki/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { readBoundedImportJson } from "./body";
import {
  createImportSchema,
  importWorkflowSourceSchema,
  type CreateImportRequest,
  type ImportWorkflowSource,
} from "./contracts";
import { safeImportFilename } from "./filename";
import { exchangeGoogleAuthorizationCode } from "./google-client";
import { GoogleTokenVault } from "./token-vault";
import type { ImportWorkflowParams } from "./workflow";
import { hashMarkdown } from "../core/markdown";
import { createUuidV7 } from "../core/ids";
import { createRealtimeWikiCoreService } from "../core/realtime-mutations";
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
  workflow_source_json: string | null;
  status: string;
  report_r2_key: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface ImportIdempotencyRow {
  request_hash: string;
  import_id: string;
  expires_at: string;
}

const googleStateSchema = z.object({
  userId: z.string(),
  expectedEmail: z.email(),
  returnTo: z.url(),
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
      context.req.query("returnTo") ??
        `${context.env.MCP_PUBLIC_ORIGIN}/imports`,
      context.env.MCP_PUBLIC_ORIGIN,
    );
    const state = crypto.randomUUID();
    await context.env.OAUTH_KV.put(
      `import:google-state:${state}`,
      JSON.stringify({ userId, expectedEmail: member.email, returnTo }),
      { expirationTtl: 600 },
    );

    const authorizationUrl = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorizationUrl.searchParams.set(
      "client_id",
      context.env.GOOGLE_CLIENT_ID,
    );
    authorizationUrl.searchParams.set(
      "redirect_uri",
      googleCallbackUrl(context.env),
    );
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
      throw new HTTPException(400, {
        message: "Invalid Google OAuth callback",
      });
    }
    const stored = await context.env.OAUTH_KV.get(
      `import:google-state:${state}`,
    );
    await context.env.OAUTH_KV.delete(`import:google-state:${state}`);
    const pending = googleStateSchema.safeParse(parseJson(stored));
    if (!pending.success) {
      throw new HTTPException(400, {
        message: "Expired Google OAuth callback",
      });
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

  routes.post("/imports", async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    const userId = identity.id;
    await requireEditor(context.env.DB, userId, identity.workspaceId);
    const parsedRequest = createImportSchema.safeParse(
      await readBoundedImportJson(context.req.raw),
    );
    if (!parsedRequest.success) {
      throw new HTTPException(400, { message: "Invalid import request" });
    }
    const request = parsedRequest.data;
    const idempotencyKey = requireImportIdempotencyKey(
      context.req.header("Idempotency-Key"),
    );
    const [keyHash, requestHash] = await Promise.all([
      hashMarkdown(idempotencyKey),
      hashMarkdown(JSON.stringify(request)),
    ]);
    const now = new Date().toISOString();
    const existingIdempotency = await getImportIdempotency(
      context.env.DB,
      userId,
      keyHash,
    );
    if (existingIdempotency !== null && existingIdempotency.expires_at > now) {
      return replayImport(context, existingIdempotency, requestHash);
    }
    if (existingIdempotency !== null) {
      await context.env.DB.prepare(
        `DELETE FROM import_request_idempotency
            WHERE user_id = ?1 AND key_hash = ?2 AND expires_at <= ?3`,
      )
        .bind(userId, keyHash, now)
        .run();
    }
    if (request.sourceType === "google_docs") {
      const vault = new GoogleTokenVault(
        context.env.OAUTH_KV,
        context.env.TOKEN_ENCRYPTION_KEY,
      );
      if ((await vault.get(userId)) === null) {
        throw new HTTPException(409, {
          message: "Connect Google before importing",
        });
      }
    }
    const importId = createUuidV7();
    const prepared = await prepareImportSource(
      context.env,
      identity.workspaceId,
      importId,
      request,
    );
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO imports (
               id, workspace_id, user_id, source_type, source_metadata_json,
               workflow_source_json, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7)`,
        ).bind(
          importId,
          identity.workspaceId,
          userId,
          databaseSourceType(request.sourceType),
          JSON.stringify(prepared.metadata),
          JSON.stringify(prepared.workflowSource),
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO import_request_idempotency (
               user_id, key_hash, request_hash, import_id, created_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(
          userId,
          keyHash,
          requestHash,
          importId,
          now,
          new Date(Date.now() + 86_400_000).toISOString(),
        ),
      ]);
    } catch (error) {
      await deletePreparedSource(context.env.FILES, prepared.workflowSource);
      const raced = await getImportIdempotency(context.env.DB, userId, keyHash);
      if (raced !== null && raced.expires_at > now) {
        return replayImport(context, raced, requestHash);
      }
      throw error;
    }

    const parameters: ImportWorkflowParams = {
      importId,
      workspaceId: identity.workspaceId,
      requestedBy: userId,
      source: prepared.workflowSource,
    };
    // Keep the durable intent queued when creation fails. A retry with the same
    // idempotency key can distinguish an existing instance from an instance
    // that was never created, even when the original create response was lost.
    await createImportWorkflow(context.env.IMPORT_WORKFLOW, parameters);
    return context.json(
      {
        id: importId,
        sourceType: request.sourceType,
        sourceLabel: sourceLabel(prepared.metadata, request.sourceType),
        status: "queued" as const,
        warnings: [],
        createdAt: now,
      },
      202,
    );
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
              workflow_source_json, status, report_r2_key,
              created_at, updated_at, expires_at
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
    const metadata = z
      .record(z.string(), z.unknown())
      .catch({})
      .parse(parseJson(value.source_metadata_json));
    return context.json(
      await importJobResponse(context.env.FILES, value, metadata),
    );
  });

  routes.post(
    "/imports/:id/apply",
    zValidator("json", applyImportRequestSchema),
    async (context) => {
      const identity = requireImportIdentity(context.get("identity"));
      await requireEditor(context.env.DB, identity.id, identity.workspaceId);
      const importId = context.req.param("id");
      const value = await context.env.DB.prepare(
        `SELECT id, workspace_id, user_id, source_type, source_metadata_json,
                workflow_source_json, status, report_r2_key,
                created_at, updated_at, expires_at
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
      const metadata = z
        .record(z.string(), z.unknown())
        .catch({})
        .parse(parseJson(value.source_metadata_json));
      if (value.status === "applied" && typeof metadata.pageId === "string") {
        return context.json(
          await createRealtimeWikiCoreService(context.env).getPage(
            identity,
            metadata.pageId,
          ),
        );
      }
      if (value.status !== "preview_ready") {
        throw new HTTPException(409, {
          message: "Import preview is not ready",
        });
      }
      if (
        value.expires_at !== null &&
        value.expires_at <= new Date().toISOString()
      ) {
        throw new HTTPException(410, { message: "Import preview has expired" });
      }
      const previewKey =
        typeof metadata.previewKey === "string" ? metadata.previewKey : null;
      if (previewKey === null) {
        throw new HTTPException(409, {
          message: "Import preview is unavailable",
        });
      }
      const preview = await context.env.FILES.get(previewKey);
      if (preview === null || preview.size > 1_048_576) {
        throw new HTTPException(409, {
          message: "Import preview is unavailable",
        });
      }
      const request = context.req.valid("json");
      const page = await createRealtimeWikiCoreService(context.env).createPage(
        identity,
        {
          parentId: request.parentId,
          title: request.title,
          bodyMd: await preview.text(),
          accessMode: "workspace",
        },
        `import:${importId}`,
      );
      await applyAcceptedTags(
        context.env.DB,
        identity.workspaceId,
        page.page.id,
        request.acceptedTags,
      );
      const appliedAt = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE imports
              SET status = 'applied',
                  source_metadata_json = json_set(source_metadata_json, '$.pageId', ?2),
                  updated_at = ?3
            WHERE id = ?1 AND status = 'preview_ready'`,
        ).bind(importId, page.page.id, appliedAt),
        context.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_id, action, target_type, target_id, metadata_json, created_at
           ) VALUES (?1, ?2, 'import.applied', 'import', ?3, ?4, ?5)
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          importId,
          identity.id,
          importId,
          JSON.stringify({
            pageId: page.page.id,
            sourceType: value.source_type,
          }),
          appliedAt,
        ),
      ]);
      return context.json(
        await createRealtimeWikiCoreService(context.env).getPage(
          identity,
          page.page.id,
        ),
        201,
      );
    },
  );

  return routes;
}

async function getImportIdempotency(
  database: D1Database,
  userId: string,
  keyHash: string,
): Promise<ImportIdempotencyRow | null> {
  return database
    .prepare(
      `SELECT request_hash, import_id, expires_at
         FROM import_request_idempotency
        WHERE user_id = ?1 AND key_hash = ?2`,
    )
    .bind(userId, keyHash)
    .first<ImportIdempotencyRow>();
}

async function replayImport(
  context: Context<ImportApi>,
  idempotency: ImportIdempotencyRow,
  requestHash: string,
): Promise<Response> {
  if (idempotency.request_hash !== requestHash) {
    throw importIdempotencyConflict();
  }
  const identity = requireImportIdentity(context.get("identity"));
  const row = await context.env.DB.prepare(
    `SELECT id, workspace_id, user_id, source_type, source_metadata_json,
            workflow_source_json, status, report_r2_key,
            created_at, updated_at, expires_at
       FROM imports WHERE id = ?1`,
  )
    .bind(idempotency.import_id)
    .first<ImportRow>();
  if (
    row?.user_id !== identity.id ||
    row.workspace_id !== identity.workspaceId
  ) {
    throw importIdempotencyConflict();
  }
  await resumeImportWorkflow(context.env, row);
  const metadata = z
    .record(z.string(), z.unknown())
    .catch({})
    .parse(parseJson(row.source_metadata_json));
  return context.json(
    await importJobResponse(context.env.FILES, row, metadata),
    200,
  );
}

async function createImportWorkflow(
  workflow: Workflow<ImportWorkflowParams>,
  parameters: ImportWorkflowParams,
): Promise<void> {
  await workflow.create({
    id: `import-${parameters.importId}`,
    params: parameters,
    retention: { successRetention: "7 days", errorRetention: "30 days" },
  });
}

async function resumeImportWorkflow(
  environment: McpRuntimeEnv,
  row: ImportRow,
): Promise<void> {
  if (row.status !== "queued" && row.status !== "running") return;
  const source = importWorkflowSourceSchema.safeParse(
    parseJson(row.workflow_source_json),
  );
  if (!source.success) {
    throw new HTTPException(409, {
      message: "Import workflow cannot be resumed",
    });
  }
  const parameters: ImportWorkflowParams = {
    importId: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.user_id,
    source: source.data,
  };
  const instance = await environment.IMPORT_WORKFLOW.get(`import-${row.id}`);
  const state = await instance.status();
  if (state.status === "unknown") {
    try {
      await createImportWorkflow(environment.IMPORT_WORKFLOW, parameters);
    } catch (error) {
      const raced = await (
        await environment.IMPORT_WORKFLOW.get(`import-${row.id}`)
      ).status();
      if (raced.status === "unknown") throw error;
    }
    return;
  }
  if (state.status === "errored" || state.status === "terminated") {
    await instance.restart();
  }
}

function requireImportIdempotencyKey(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new HTTPException(400, {
      message: "Idempotency-Key must contain between 1 and 200 characters",
    });
  }
  return trimmed;
}

function importIdempotencyConflict(): HTTPException {
  return new HTTPException(409, {
    message: "This idempotency key was used with a different import request",
  });
}

async function deletePreparedSource(
  bucket: R2Bucket,
  source: ImportWorkflowSource,
): Promise<void> {
  if ("sourceKey" in source) await bucket.delete(source.sourceKey);
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
  if (member === null)
    throw new HTTPException(401, { message: "Authentication required" });
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

async function importJobResponse(
  bucket: R2Bucket,
  row: ImportRow,
  metadata: Record<string, unknown>,
): Promise<{
  id: string;
  sourceType: ImportSourceType;
  sourceLabel: string;
  status: "queued" | "running" | "preview_ready" | "applied" | "failed";
  previewMarkdown?: string;
  warnings: string[];
  suggestedTitle?: string;
  error?: { code: string; message: string };
  createdAt: string;
}> {
  const previewKey =
    typeof metadata.previewKey === "string" ? metadata.previewKey : null;
  const previewObject =
    previewKey === null ? null : await bucket.get(previewKey);
  const previewMarkdown =
    previewObject === null || previewObject.size > 1_048_576
      ? undefined
      : await previewObject.text();
  const reportObject =
    row.report_r2_key === null ? null : await bucket.get(row.report_r2_key);
  const report = z
    .object({ warnings: z.array(z.string()).catch([]) })
    .catch({ warnings: [] })
    .parse(
      reportObject === null || reportObject.size > 1_048_576
        ? null
        : await reportObject.json<unknown>(),
    );
  const errorMessage =
    typeof metadata.error === "string" ? metadata.error : undefined;
  const suggestedTitle =
    typeof metadata.title === "string" ? metadata.title : undefined;
  return {
    id: row.id,
    sourceType: publicSourceType(row.source_type),
    sourceLabel: sourceLabel(metadata, publicSourceType(row.source_type)),
    status: publicImportStatus(row.status),
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    warnings: report.warnings,
    ...(suggestedTitle === undefined ? {} : { suggestedTitle }),
    ...(errorMessage === undefined
      ? {}
      : { error: { code: "IMPORT_FAILED", message: errorMessage } }),
    createdAt: row.created_at,
  };
}

function publicImportStatus(
  value: string,
): "queued" | "running" | "preview_ready" | "applied" | "failed" {
  if (
    value === "queued" ||
    value === "running" ||
    value === "preview_ready" ||
    value === "applied"
  ) {
    return value;
  }
  return "failed";
}

function publicSourceType(value: string): ImportSourceType {
  if (value === "public_url") return "url";
  if (
    value === "google_docs" ||
    value === "markdown" ||
    value === "pdf" ||
    value === "paste"
  ) {
    return value;
  }
  throw new Error("Import source type is invalid");
}

function databaseSourceType(value: ImportSourceType): string {
  return value === "url" ? "public_url" : value;
}

function sourceLabel(
  metadata: Record<string, unknown>,
  sourceType: ImportSourceType,
): string {
  if (typeof metadata.title === "string") return metadata.title;
  if (typeof metadata.filename === "string") return metadata.filename;
  if (typeof metadata.sourceUrl === "string") return metadata.sourceUrl;
  if (typeof metadata.documentId === "string") {
    return `Google Document: ${metadata.documentId}`;
  }
  return sourceType === "google_docs" ? "Google Document" : "Imported Document";
}

async function applyAcceptedTags(
  database: D1Database,
  workspaceId: string,
  pageId: string,
  acceptedTags: string[],
): Promise<void> {
  const tags = new Map<string, string>();
  for (const tag of acceptedTags) {
    const name = tag.normalize("NFKC").trim();
    if (name.length > 0) tags.set(name.toLowerCase(), name);
  }
  if (tags.size === 0) return;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const [normalizedName, name] of tags) {
    statements.push(
      database
        .prepare(
          `INSERT INTO tags (
             id, workspace_id, name, normalized_name, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, normalized_name) DO NOTHING`,
        )
        .bind(createUuidV7(), workspaceId, name, normalizedName, now),
      database
        .prepare(
          `INSERT INTO page_tags (page_id, tag_id)
           SELECT ?1, id FROM tags
            WHERE workspace_id = ?2 AND normalized_name = ?3
           ON CONFLICT(page_id, tag_id) DO NOTHING`,
        )
        .bind(pageId, workspaceId, normalizedName),
    );
  }
  await database.batch(statements);
}

async function prepareImportSource(
  environment: McpRuntimeEnv,
  workspaceId: string,
  importId: string,
  request: CreateImportRequest,
): Promise<{
  metadata: Record<string, string>;
  workflowSource: ImportWorkflowSource;
}> {
  if (request.sourceType === "google_docs") {
    return {
      metadata: { documentId: request.documentId },
      workflowSource: {
        sourceType: "google_docs",
        documentId: request.documentId,
      },
    };
  }
  if (request.sourceType === "url") {
    return {
      metadata: { sourceUrl: request.sourceUrl },
      workflowSource: {
        sourceType: "public_url",
        sourceUrl: request.sourceUrl,
      },
    };
  }

  const prepared =
    request.sourceType === "pdf"
      ? preparePdf(request.content, request.filename)
      : prepareTextSource(
          request.content,
          request.sourceType,
          request.filename,
        );
  const sourceKey = `imports/${workspaceId}/${importId}/source/${prepared.filename}`;
  await environment.FILES.put(sourceKey, prepared.bytes, {
    httpMetadata: { contentType: prepared.contentType },
    customMetadata: {
      import_id: importId,
      source_type: request.sourceType,
    },
  });
  return {
    metadata: { filename: prepared.filename },
    workflowSource: {
      sourceType: request.sourceType,
      sourceKey,
      filename: prepared.filename,
      contentType: prepared.contentType,
    },
  };
}

function prepareTextSource(
  content: string,
  sourceType: "markdown" | "paste",
  filename: string | undefined,
): { bytes: Uint8Array; filename: string; contentType: string } {
  const bytes = new TextEncoder().encode(content);
  const limit = sourceType === "markdown" ? 1_048_576 : 5 * 1024 * 1024;
  if (bytes.byteLength > limit) {
    throw new HTTPException(413, { message: "Import content is too large" });
  }
  const html = sourceType === "paste" && looksLikeHtml(content, filename);
  return {
    bytes,
    filename: safeImportFilename(
      filename ?? (html ? "pasted-content.html" : "pasted-content.txt"),
    ),
    contentType: html
      ? "text/html; charset=utf-8"
      : sourceType === "markdown"
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
  };
}

function preparePdf(
  content: string,
  filename: string,
): { bytes: Uint8Array; filename: string; contentType: string } {
  const payload = content
    .replace(/^data:application\/pdf;base64,/iu, "")
    .replaceAll(/\s/gu, "");
  if (!/^[A-Za-z\d+/]*={0,2}$/u.test(payload) || payload.length % 4 !== 0) {
    throw new HTTPException(400, {
      message: "PDF content must be valid base64",
    });
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedSize = (payload.length / 4) * 3 - padding;
  if (decodedSize > 20 * 1024 * 1024) {
    throw new HTTPException(413, {
      message: "PDF exceeds the 20 MiB import limit",
    });
  }
  const bytes = decodeBase64(payload, decodedSize);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new HTTPException(400, {
      message: "PDF content has an invalid signature",
    });
  }
  const normalizedFilename = safeImportFilename(filename);
  return {
    bytes,
    filename: normalizedFilename.toLowerCase().endsWith(".pdf")
      ? normalizedFilename
      : `${normalizedFilename}.pdf`,
    contentType: "application/pdf",
  };
}

function decodeBase64(payload: string, decodedSize: number): Uint8Array {
  const output = new Uint8Array(decodedSize);
  let outputOffset = 0;
  try {
    for (let offset = 0; offset < payload.length; offset += 32_768) {
      const decoded = atob(payload.slice(offset, offset + 32_768));
      for (let index = 0; index < decoded.length; index += 1) {
        output[outputOffset] = decoded.charCodeAt(index);
        outputOffset += 1;
      }
    }
  } catch {
    throw new HTTPException(400, {
      message: "PDF content must be valid base64",
    });
  }
  if (outputOffset !== decodedSize) {
    throw new HTTPException(400, {
      message: "PDF content must be valid base64",
    });
  }
  return output;
}

function looksLikeHtml(content: string, filename: string | undefined): boolean {
  return (
    filename?.toLowerCase().endsWith(".html") === true ||
    /<\s*(?:!doctype|html|head|body|article|main|p|div|h[1-6]|ul|ol|table|a)\b/iu.test(
      content,
    )
  );
}
