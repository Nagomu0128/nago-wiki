import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { startPortableExport } from "./service";
import type { McpRuntimeEnv } from "../mcp/types";

interface ExportApi {
  Bindings: McpRuntimeEnv;
  Variables: {
    identity: AuthenticatedIdentity | undefined;
    requestId: string | undefined;
    userId: string | undefined;
  };
}

interface ExportRow {
  id: string;
  workspace_id: string;
  user_id: string;
  status: "queued" | "running" | "ready" | "failed" | "cancelled";
  r2_key: string | null;
  page_count: number;
  archive_size: number | null;
  archive_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export function createExportRoutes(): Hono<ExportApi> {
  const routes = new Hono<ExportApi>();

  routes.post("/exports", async (context) => {
    const identity = requireExportIdentity(context.get("identity"));
    await requireOwner(context.env.DB, identity);
    const result = await startPortableExport(context.env, {
      workspaceId: identity.workspaceId,
      requestedBy: identity.id,
    });
    return context.json({ id: result.id, status: result.status }, 202);
  });

  routes.get("/exports/:id", async (context) => {
    const identity = requireExportIdentity(context.get("identity"));
    await requireOwner(context.env.DB, identity);
    const row = await findExport(context.env.DB, context.req.param("id"), identity);
    return context.json({
      id: row.id,
      workspaceId: row.workspace_id,
      status: row.status,
      pageCount: row.page_count,
      archiveSize: row.archive_size,
      archiveHash: row.archive_hash,
      error: row.error_message,
      downloadUrl:
        row.status === "ready" ? `/api/v1/exports/${row.id}/download` : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    });
  });

  routes.get("/exports/:id/download", async (context) => {
    const identity = requireExportIdentity(context.get("identity"));
    await requireOwner(context.env.DB, identity);
    const row = await findExport(context.env.DB, context.req.param("id"), identity);
    if (row.status !== "ready" || row.r2_key === null) {
      throw new HTTPException(409, { message: "Export archive is not ready" });
    }
    if (row.expires_at !== null && row.expires_at <= new Date().toISOString()) {
      throw new HTTPException(410, { message: "Export archive has expired" });
    }
    const object = await context.env.FILES.get(row.r2_key);
    if (object === null) {
      throw new HTTPException(410, { message: "Export archive is unavailable" });
    }
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="nago-wiki-${row.id}.zip"`,
        "Content-Length": String(object.size),
        "Content-Type": "application/zip",
        ETag: object.httpEtag,
      },
    });
  });

  return routes;
}

async function requireOwner(
  database: D1Database,
  identity: AuthenticatedIdentity,
): Promise<void> {
  const member = await database
    .prepare(
      `SELECT role FROM users
        WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'`,
    )
    .bind(identity.id, identity.workspaceId)
    .first<{ role: "owner" | "editor" | "viewer" }>();
  if (member === null) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  if (member.role !== "owner") {
    throw new HTTPException(403, { message: "Owner permission required" });
  }
}

async function findExport(
  database: D1Database,
  exportId: string,
  identity: AuthenticatedIdentity,
): Promise<ExportRow> {
  const row = await database
    .prepare(
      `SELECT id, workspace_id, user_id, status, r2_key, page_count,
              archive_size, archive_hash, error_message,
              created_at, updated_at, expires_at
         FROM exports
        WHERE id = ?1 AND workspace_id = ?2`,
    )
    .bind(exportId, identity.workspaceId)
    .first<ExportRow>();
  if (row === null) throw new HTTPException(404, { message: "Export not found" });
  return row;
}

function requireExportIdentity(
  identity: AuthenticatedIdentity | undefined,
): AuthenticatedIdentity {
  if (identity === undefined) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return identity;
}
