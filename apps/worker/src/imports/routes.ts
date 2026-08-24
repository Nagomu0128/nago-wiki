import { zValidator } from "@hono/zod-validator";
import {
  applyImportRequestSchema,
  type AuthenticatedIdentity,
  type CreateImportRequest,
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
  type ImportWorkflowSource,
} from "./contracts";
import { safeImportFilename } from "./filename";
import {
  exchangeGoogleAuthorizationCode,
  getGoogleAccessToken,
} from "./google-client";
import { GoogleTokenVault } from "./token-vault";
import type { ImportWorkflowParams } from "./workflow";
import {
  finalizeGoogleImportAssets,
  type ImportedGoogleAsset,
} from "./google-inline-images";
import { createUuidV7 } from "../core/ids";
import { hashMarkdown } from "../core/markdown";
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
  workflow_source_json: string | null;
  status: string;
  report_r2_key: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface ImportIdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  import_id: string;
  expires_at: string;
}

interface ImportApplicationRow extends Record<string, unknown> {
  import_id: string;
  page_id: string;
  accepted_tags_json: string;
  status: "applying" | "applied";
}

const googleStateSchema = z.object({
  userId: z.string(),
  expectedEmail: z.email(),
  returnTo: z.url(),
});

const legacyWebCreateImportSchema = z.object({
  source: z.object({
    type: z.literal("google_docs"),
    documentId: z.string().min(1).max(256),
  }),
}).strict();

const applyImportSchema = applyImportRequestSchema;

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

  routes.post("/imports", async (context) => {
    const identity = requireImportIdentity(context.get("identity"));
    const userId = identity.id;
    await requireEditor(context.env.DB, userId, identity.workspaceId);
    const request = normalizeCreateImportRequest(
      await readBoundedImportJson(context.req.raw),
    );
    const suppliedKey = context.req.header("Idempotency-Key")?.trim();
    if (suppliedKey !== undefined && (suppliedKey.length === 0 || suppliedKey.length > 200)) {
      throw new HTTPException(400, {
        message: "Idempotency-Key must contain between 1 and 200 characters",
      });
    }
    const importId = createUuidV7();
    // Old Web clients did not send an idempotency header. Keep that payload
    // working while making every current client request replay-safe.
    const idempotencyKey = suppliedKey ?? `legacy:${importId}`;
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
        throw new HTTPException(409, { message: "Connect Google before importing" });
      }
    }
    const targetPageId = createUuidV7();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const prepared = await prepareImportSource(
      context.env,
      identity.workspaceId,
      importId,
      request,
    );
    const metadata = { ...prepared.metadata, targetPageId };
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO imports (
             id, workspace_id, user_id, source_type, source_metadata_json,
             workflow_source_json, status, created_at, updated_at, expires_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7, ?8)`,
        ).bind(
          importId,
          identity.workspaceId,
          userId,
          databaseSourceType(request.sourceType),
          JSON.stringify(metadata),
          JSON.stringify(prepared.workflowSource),
          now,
          expiresAt,
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
      const raced = await getImportIdempotency(context.env.DB, userId, keyHash);
      if (raced !== null && raced.expires_at > now) {
        if (raced.import_id !== importId) {
          await deletePreparedSource(context.env.FILES, prepared.workflowSource);
        }
        return replayImport(context, raced, requestHash);
      }
      await deletePreparedSource(context.env.FILES, prepared.workflowSource);
      throw error;
    }

    const parameters: ImportWorkflowParams = {
      importId,
      workspaceId: identity.workspaceId,
      requestedBy: userId,
      targetPageId,
      source: prepared.workflowSource,
    };
    // The durable queued intent is reconciled if Workflow creation fails or
    // its response is lost.
    await createImportWorkflow(context.env.IMPORT_WORKFLOW, parameters).catch(
      (error: unknown) => {
        console.error("Deferred import Workflow creation", {
          importId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      },
    );
    return context.json({
      id: importId,
      sourceType: request.sourceType,
      sourceLabel: sourceLabel(metadata, request.sourceType),
      status: "queued" as const,
      warnings: [],
      metadata,
      createdAt: now,
      updatedAt: now,
      expiresAt,
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
    const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
      parseJson(value.source_metadata_json),
    );
    const previewKey = typeof metadata.previewKey === "string" ? metadata.previewKey : null;
    const preview = previewKey === null ? null : await context.env.FILES.get(previewKey);
    const report = value.report_r2_key === null
      ? null
      : await readImportReport(context.env.FILES, value.report_r2_key);
    const title = typeof metadata.title === "string" ? metadata.title : undefined;
    const sourceType = publicSourceType(value.source_type);
    const errorMessage = typeof metadata.error === "string" ? metadata.error : undefined;
    return context.json({
      id: value.id,
      workspaceId: value.workspace_id,
      sourceType,
      sourceLabel: title ?? sourceLabel(metadata, sourceType),
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
      const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
        parseJson(value.source_metadata_json),
      );
      if (value.status === "applied" && typeof metadata.pageId === "string") {
        return context.json(await createRealtimeWikiCoreService(context.env).getPage(
          identity,
          metadata.pageId,
        ));
      }
      let application = await getImportApplication(context.env.DB, importId);
      if (application === null && value.status !== "preview_ready") {
        throw new HTTPException(409, { message: "Import preview is not ready" });
      }
      if (
        application === null &&
        value.expires_at !== null &&
        value.expires_at <= new Date().toISOString()
      ) {
        throw new HTTPException(410, { message: "Import preview has expired" });
      }
      const report = value.report_r2_key === null
        ? null
        : await readImportReport(context.env.FILES, value.report_r2_key);
      if (report === null) {
        throw new HTTPException(409, { message: "Import asset report is unavailable" });
      }
      const core = createRealtimeWikiCoreService(context.env);
      let createdStatus = 200;
      if (application === null) {
        const previewKey =
          typeof metadata.previewKey === "string" ? metadata.previewKey : null;
        const targetPageId = typeof metadata.targetPageId === "string"
          ? metadata.targetPageId
          : null;
        if (previewKey === null || targetPageId === null) {
          throw new HTTPException(409, { message: "Import preview is unavailable" });
        }
        const preview = await context.env.FILES.get(previewKey);
        if (preview === null || preview.size > 1_048_576) {
          throw new HTTPException(409, { message: "Import preview is unavailable" });
        }
        const request = context.req.valid("json");
        try {
          await core.createImportedPageWithId(
            identity,
            targetPageId,
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
            { importId, acceptedTags: request.acceptedTags },
          );
          createdStatus = 201;
        } catch (error) {
          application = await getImportApplication(context.env.DB, importId);
          if (application === null) throw error;
        }
        application ??= await getImportApplication(context.env.DB, importId);
      }
      if (application === null) {
        throw new HTTPException(503, { message: "Import application could not be resumed" });
      }
      const acceptedTags = z.array(z.string().trim().min(1).max(100)).max(50).parse(
        parseJson(application.accepted_tags_json),
      );
      try {
        await finalizeGoogleImportAssets({
          files: context.env.FILES,
          workspaceId: identity.workspaceId,
          importId,
          pageId: application.page_id,
          uploadedBy: identity.id,
          assets: report.assets,
        });
      } catch (error) {
        console.error(JSON.stringify({
          message: "Google import asset finalization failed",
          importId,
          pageId: application.page_id,
          error: publicImportError(error),
        }));
        throw new HTTPException(503, {
          message: "Imported images could not be finalized; retry the import",
        });
      }
      await new TagsService(context.env.DB).replaceImportedPageTags(
        identity.workspaceId,
        application.page_id,
        acceptedTags,
      );
      const finalizedAt = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE import_applications
              SET status = 'applied', updated_at = ?2
            WHERE import_id = ?1 AND status = 'applying'`,
        ).bind(importId, finalizedAt),
        context.env.DB.prepare(
          `UPDATE imports
              SET status = 'applied',
                  source_metadata_json = json_set(source_metadata_json, '$.pageId', ?2),
                  updated_at = ?3
            WHERE id = ?1`,
        ).bind(importId, application.page_id, finalizedAt),
      ]);
      return context.json(
        await core.getPage(identity, application.page_id),
        createdStatus === 201 ? 201 : 200,
      );
    },
  );

  return routes;
}

function normalizeCreateImportRequest(value: unknown): CreateImportRequest {
  const canonical = createImportSchema.safeParse(value);
  if (canonical.success) return canonical.data;
  const legacy = legacyWebCreateImportSchema.safeParse(value);
  if (legacy.success) {
    return {
      sourceType: "google_docs",
      documentId: legacy.data.source.documentId,
    };
  }
  throw new HTTPException(400, { message: "Invalid import request" });
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
    throw new HTTPException(409, {
      message: "This idempotency key was used with a different import request",
    });
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
    throw new HTTPException(409, {
      message: "This idempotency key belongs to another import",
    });
  }
  await resumeImportWorkflow(context.env, row);
  const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
    parseJson(row.source_metadata_json),
  );
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
  const parameters = importWorkflowParameters(row);
  if (parameters === null) {
    throw new HTTPException(409, { message: "Import workflow cannot be resumed" });
  }
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

function importWorkflowParameters(row: ImportRow): ImportWorkflowParams | null {
  const metadata = z.record(z.string(), z.unknown()).catch({}).parse(
    parseJson(row.source_metadata_json),
  );
  const targetPageId =
    typeof metadata.targetPageId === "string" ? metadata.targetPageId : null;
  if (targetPageId === null) return null;
  let source = importWorkflowSourceSchema.safeParse(
    parseJson(row.workflow_source_json),
  );
  // Rows created by the pre-portable Google endpoint did not persist the
  // Workflow payload separately. Reconstruct that durable intent in place.
  if (!source.success && row.source_type === "google_docs") {
    source = importWorkflowSourceSchema.safeParse({
      type: "google_docs",
      documentId: metadata.documentId,
    });
  }
  if (!source.success) return null;
  return {
    importId: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.user_id,
    targetPageId,
    source: source.data,
  };
}

export async function reconcileQueuedImports(
  environment: McpRuntimeEnv,
  now = new Date(),
): Promise<{ resumed: number; failed: number }> {
  const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const rows = await environment.DB.prepare(
    `SELECT id, workspace_id, user_id, source_type, source_metadata_json,
            workflow_source_json, status, report_r2_key,
            created_at, updated_at, expires_at
       FROM imports
      WHERE status IN ('queued', 'running') AND updated_at <= ?1
      ORDER BY updated_at, id
      LIMIT 100`,
  )
    .bind(cutoff)
    .all<ImportRow>();
  let resumed = 0;
  let failed = 0;
  for (const row of rows.results) {
    if (importWorkflowParameters(row) === null) {
      const failedAt = now.toISOString();
      await environment.DB.prepare(
        `UPDATE imports
            SET status = 'failed',
                source_metadata_json = json_set(
                  source_metadata_json,
                  '$.error',
                  'Import workflow cannot be resumed after migration'
                ),
                updated_at = ?2, expires_at = ?3
          WHERE id = ?1 AND status IN ('queued', 'running')`,
      )
        .bind(
          row.id,
          failedAt,
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        )
        .run();
      failed += 1;
      continue;
    }
    try {
      await resumeImportWorkflow(environment, row);
      await environment.DB.prepare(
        `UPDATE imports SET updated_at = ?2
          WHERE id = ?1 AND status IN ('queued', 'running')`,
      )
        .bind(row.id, now.toISOString())
        .run();
      resumed += 1;
    } catch (error) {
      failed += 1;
      await environment.DB.prepare(
        `UPDATE imports SET updated_at = ?2
          WHERE id = ?1 AND status IN ('queued', 'running')`,
      )
        .bind(row.id, now.toISOString())
        .run();
      console.error("Failed to reconcile queued import", {
        importId: row.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { resumed, failed };
}

async function importJobResponse(
  bucket: R2Bucket,
  row: ImportRow,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const previewKey =
    typeof metadata.previewKey === "string" ? metadata.previewKey : null;
  const preview = previewKey === null ? null : await bucket.get(previewKey);
  const report =
    row.report_r2_key === null
      ? null
      : await readImportReport(bucket, row.report_r2_key);
  const title = typeof metadata.title === "string" ? metadata.title : undefined;
  const errorMessage =
    typeof metadata.error === "string" ? metadata.error : undefined;
  const sourceType = publicSourceType(row.source_type);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceType,
    sourceLabel: title ?? sourceLabel(metadata, sourceType),
    status: row.status,
    metadata,
    previewMarkdown:
      preview === null || preview.size > 1_048_576 ? null : await preview.text(),
    warnings: report?.warnings ?? [],
    ...(title === undefined ? {} : { suggestedTitle: title }),
    ...(errorMessage === undefined
      ? {}
      : { error: { code: "IMPORT_FAILED", message: errorMessage } }),
    reportKey: row.report_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
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
      workflowSource: { type: "google_docs", documentId: request.documentId },
    };
  }
  if (request.sourceType === "url") {
    return {
      metadata: { sourceUrl: request.sourceUrl },
      workflowSource: { type: "public_url", sourceUrl: request.sourceUrl },
    };
  }
  const prepared =
    request.sourceType === "pdf"
      ? preparePdf(request.content, request.filename)
      : prepareTextSource(request.content, request.sourceType, request.filename);
  const sourceKey = `imports/${workspaceId}/${importId}/source/${prepared.filename}`;
  await environment.FILES.put(sourceKey, prepared.bytes, {
    httpMetadata: { contentType: prepared.contentType },
    customMetadata: {
      import_id: importId,
      source_type: request.sourceType,
    },
  });
  return {
    metadata: { filename: prepared.filename, sourceKey },
    workflowSource: {
      type: request.sourceType,
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
    throw new HTTPException(400, { message: "PDF content must be valid base64" });
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedSize = (payload.length / 4) * 3 - padding;
  if (decodedSize > 20 * 1024 * 1024) {
    throw new HTTPException(413, { message: "PDF exceeds the 20 MiB import limit" });
  }
  const bytes = decodeBase64(payload, decodedSize);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new HTTPException(400, { message: "PDF content has an invalid signature" });
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
    throw new HTTPException(400, { message: "PDF content must be valid base64" });
  }
  if (outputOffset !== decodedSize) {
    throw new HTTPException(400, { message: "PDF content must be valid base64" });
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

async function deletePreparedSource(
  bucket: R2Bucket,
  source: ImportWorkflowSource,
): Promise<void> {
  if ("sourceKey" in source) await bucket.delete(source.sourceKey);
}

async function getImportApplication(
  database: D1Database,
  importId: string,
): Promise<ImportApplicationRow | null> {
  return database.prepare(
    `SELECT import_id, page_id, accepted_tags_json, status
       FROM import_applications
      WHERE import_id = ?1`,
  )
    .bind(importId)
    .first<ImportApplicationRow>();
}

async function readImportReport(
  files: R2Bucket,
  key: string,
): Promise<{ warnings: string[]; assets: ImportedGoogleAsset[] } | null> {
  const object = await files.get(key);
  if (object === null || object.size > 1_048_576) return null;
  try {
    const parsed = z.object({
      warnings: z.array(z.string().max(1_000)).max(100).default([]),
      assets: z.array(z.object({
        objectId: z.string().min(1).max(500),
        assetId: z.uuid(),
        filename: z.string().min(1).max(200),
        contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        size: z.number().int().positive().max(10 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        stagingKey: z.string().min(1).max(2_048),
        finalKey: z.string().min(1).max(2_048),
        url: z.string().min(1).max(2_048).startsWith("/api/v1/pages/"),
        altText: z.string().max(500),
      })).max(50).default([]),
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

function publicImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : "asset finalization failed";
  return message.replace(/https?:\/\/\S+/giu, "[redacted URL]").slice(0, 300);
}
