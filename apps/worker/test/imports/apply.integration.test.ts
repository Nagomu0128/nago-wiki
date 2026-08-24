import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { hashMarkdown } from "../../src/core/markdown";
import { createImportRoutes } from "../../src/imports/routes";
import type { McpRuntimeEnv } from "../../src/mcp/types";

const identity: AuthenticatedIdentity = {
  id: "apply-owner",
  email: "apply-owner@example.com",
  displayName: "Apply Owner",
  workspaceId: "apply-workspace",
  role: "owner",
  status: "active",
  subject: "apply-owner-subject",
  expiresAt: Date.now() + 60_000,
};

describe("POST /imports/:id/apply", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM audit_events"),
      env.DB.prepare("DELETE FROM page_tags"),
      env.DB.prepare("DELETE FROM tags"),
      env.DB.prepare("DELETE FROM page_create_idempotency"),
      env.DB.prepare("DELETE FROM page_versions"),
      env.DB.prepare("DELETE FROM imports"),
      env.DB.prepare("DELETE FROM pages"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM workspaces"),
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Apply test', ?2)",
      ).bind(identity.workspaceId, new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO users (
           id, workspace_id, email, display_name, role, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 'owner', 'active', ?5, ?5)`,
      ).bind(
        identity.id,
        identity.workspaceId,
        identity.email,
        identity.displayName,
        new Date().toISOString(),
      ),
    ]);
  });

  it("does not claim an import until preview and report artifacts are valid", async () => {
    const importId = "missing-report";
    const previewKey = `imports/${identity.workspaceId}/${importId}/preview.md`;
    await env.FILES.put(previewKey, "# Preview");
    await insertPreviewImport(importId, { previewKey }, `${previewKey}.missing`);

    const response = await apply(importId, {
      parentId: null,
      title: "Imported",
      acceptedTags: [],
    });
    const row = await env.DB.prepare(
      "SELECT expires_at, source_metadata_json FROM imports WHERE id = ?1",
    )
      .bind(importId)
      .first<{ expires_at: string | null; source_metadata_json: string }>();

    expect(response.status).toBe(409);
    expect(row?.expires_at).not.toBeNull();
    expect(JSON.parse(row?.source_metadata_json ?? "{}")).not.toHaveProperty(
      "applying",
    );
  });

  it("rejects an active claim made with different apply options", async () => {
    const importId = "active-claim";
    const previewKey = `imports/${identity.workspaceId}/${importId}/preview.md`;
    const reportKey = `imports/${identity.workspaceId}/${importId}/report.json`;
    await Promise.all([
      env.FILES.put(previewKey, "# Preview"),
      env.FILES.put(reportKey, JSON.stringify({ warnings: [] })),
    ]);
    await insertPreviewImport(
      importId,
      {
        previewKey,
        applying: 1,
        applyLeaseId: "other-lease",
        applyLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
        applyRequestHash: "different-request",
      },
      reportKey,
    );

    const response = await apply(importId, {
      parentId: null,
      title: "Imported",
      acceptedTags: ["mine"],
    });

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM pages").first(),
    ).toEqual({ count: 0 });
  });

  it("reclaims a stale lease for the original request", async () => {
    const importId = "stale-claim";
    const previewKey = `imports/${identity.workspaceId}/${importId}/preview.md`;
    const reportKey = `imports/${identity.workspaceId}/${importId}/report.json`;
    const request = {
      parentId: null,
      title: "Recovered import",
      acceptedTags: ["recovered"],
    };
    const requestHash = await hashMarkdown(JSON.stringify(request));
    await Promise.all([
      env.FILES.put(previewKey, "# Recovered"),
      env.FILES.put(reportKey, JSON.stringify({ warnings: [] })),
    ]);
    await insertPreviewImport(
      importId,
      {
        previewKey,
        applying: 1,
        applyLeaseId: "stale-lease",
        applyLeaseUntil: "2020-01-01T00:00:00.000Z",
        applyRequestHash: requestHash,
      },
      reportKey,
    );

    const response = await apply(importId, request);
    const row = await env.DB.prepare(
      "SELECT status, source_metadata_json FROM imports WHERE id = ?1",
    )
      .bind(importId)
      .first<{ status: string; source_metadata_json: string }>();

    expect(response.status).toBe(201);
    expect(row?.status).toBe("applied");
    expect(JSON.parse(row?.source_metadata_json ?? "{}")).not.toHaveProperty(
      "applyLeaseId",
    );
  });

  it("releases its lease when page creation fails so the request can retry", async () => {
    const importId = "failed-create";
    const previewKey = `imports/${identity.workspaceId}/${importId}/preview.md`;
    const reportKey = `imports/${identity.workspaceId}/${importId}/report.json`;
    await Promise.all([
      env.FILES.put(previewKey, "# Retry me"),
      env.FILES.put(reportKey, JSON.stringify({ warnings: [] })),
    ]);
    await insertPreviewImport(importId, { previewKey }, reportKey);

    const response = await apply(importId, {
      parentId: "00000000-0000-4000-8000-000000000000",
      title: "Invalid parent",
      acceptedTags: [],
    });
    const row = await env.DB.prepare(
      "SELECT expires_at, source_metadata_json FROM imports WHERE id = ?1",
    )
      .bind(importId)
      .first<{ expires_at: string | null; source_metadata_json: string }>();
    const metadata = JSON.parse(row?.source_metadata_json ?? "{}") as Record<
      string,
      unknown
    >;

    // This isolated Hono test app has no production ApiProblem error mapper,
    // so the page-service 404 is surfaced as a generic 500 here.
    expect(response.status).toBe(500);
    expect(row?.expires_at).not.toBeNull();
    expect(metadata).not.toHaveProperty("applyLeaseId");
    expect(metadata).not.toHaveProperty("applyLeaseUntil");
    expect(metadata.applyRequestHash).toEqual(expect.any(String));
  });

  it("returns a stable conflict when the applied page is in trash", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO pages (
         id, workspace_id, parent_id, slug, title, body_md, revision,
         content_hash, access_mode, status, created_by, created_at, updated_at,
         trashed_at, trash_batch_id
       ) VALUES (
         'trashed-page', ?1, NULL, 'trashed-page', 'Trashed', '', 1,
         ?2, 'workspace', 'trashed', ?3, ?4, ?4, ?4, 'trash-batch'
       )`,
    )
      .bind(identity.workspaceId, "0".repeat(64), identity.id, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO imports (
         id, workspace_id, user_id, source_type, source_metadata_json,
         workflow_source_json, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'paste', ?4, NULL, 'applied', ?5, ?5)`,
    )
      .bind(
        "trashed-import",
        identity.workspaceId,
        identity.id,
        JSON.stringify({ pageId: "trashed-page" }),
        now,
      )
      .run();

    const response = await apply("trashed-import", {
      parentId: null,
      title: "Ignored",
      acceptedTags: [],
    });

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM pages").first(),
    ).toEqual({ count: 1 });
  });
});

async function apply(
  importId: string,
  body: { parentId: string | null; title: string; acceptedTags: string[] },
): Promise<Response> {
  const application = new Hono<{
    Bindings: McpRuntimeEnv;
    Variables: { identity: AuthenticatedIdentity };
  }>();
  application.use("*", async (context, next) => {
    context.set("identity", identity);
    await next();
  });
  application.route("/", createImportRoutes());
  return application.request(
    `https://wiki.example/imports/${importId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function insertPreviewImport(
  importId: string,
  metadata: Record<string, unknown>,
  reportKey: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO imports (
       id, workspace_id, user_id, source_type, source_metadata_json,
       workflow_source_json, status, report_r2_key, created_at, updated_at, expires_at
     ) VALUES (?1, ?2, ?3, 'paste', ?4, NULL, 'preview_ready', ?5, ?6, ?6, ?7)`,
  )
    .bind(
      importId,
      identity.workspaceId,
      identity.id,
      JSON.stringify(metadata),
      reportKey,
      now,
      new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    )
    .run();
}
