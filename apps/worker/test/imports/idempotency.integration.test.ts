import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupOrphanedImportArtifacts } from "../../src/imports/cleanup";
import {
  createImportRoutes,
  reconcileQueuedImports,
} from "../../src/imports/routes";
import { GoogleTokenVault } from "../../src/imports/token-vault";
import type { ImportWorkflowParams } from "../../src/imports/workflow";
import type { McpRuntimeEnv } from "../../src/mcp/types";

const identity: AuthenticatedIdentity = {
  id: "import-owner",
  email: "import-owner@example.com",
  displayName: "Import Owner",
  workspaceId: "import-workspace",
  role: "owner",
  status: "active",
  subject: "import-owner-subject",
  expiresAt: Date.now() + 60_000,
};

describe("POST /imports portable recovery", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM portable_maintenance_state"),
      env.DB.prepare("DELETE FROM import_cleanup"),
      env.DB.prepare("DELETE FROM import_applications"),
      env.DB.prepare("DELETE FROM import_request_idempotency"),
      env.DB.prepare("DELETE FROM imports"),
      env.DB.prepare("DELETE FROM pages"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM workspaces"),
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Import test', ?2)",
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
    let listing: R2Objects;
    do {
      listing = await env.FILES.list({
        prefix: `imports/${identity.workspaceId}/`,
        limit: 1_000,
      });
      if (listing.objects.length > 0) {
        await env.FILES.delete(listing.objects.map((object) => object.key));
      }
    } while (listing.truncated || listing.objects.length > 0);
  });

  it("replays one durable job and rejects a mismatched payload", async () => {
    const create = vi.fn((options: { params: ImportWorkflowParams }) =>
      Promise.resolve({ id: options.params.importId }),
    );
    const application = testApp();
    const environment = workflowEnvironment(create, "running");
    const request = (content: string) =>
      application.request(
        "https://wiki.example/imports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "portable-import-1",
          },
          body: JSON.stringify({ sourceType: "paste", content }),
        },
        environment,
      );

    const first = await request("same memo");
    const replay = await request("same memo");
    const conflict = await request("different memo");

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: (await first.json<{ id: string }>()).id,
      status: "queued",
    });
    expect(conflict.status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM imports").first(),
    ).toEqual({ count: 1 });
  });

  it("keeps the deployed Web Google payload compatible without a key", async () => {
    const application = testApp();
    const tokenKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const values = new Map<string, string>();
    const oauthKv = {
      put: (key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve();
      },
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      delete: (key: string) => {
        values.delete(key);
        return Promise.resolve();
      },
    } as unknown as KVNamespace;
    const workerEnv = {
      ...workflowEnvironment(
        vi.fn(() => Promise.resolve({ id: "workflow" })),
        "running",
      ),
      OAUTH_KV: oauthKv,
      TOKEN_ENCRYPTION_KEY: tokenKey,
    } as McpRuntimeEnv;
    const vault = new GoogleTokenVault(
      workerEnv.OAUTH_KV,
      tokenKey,
    );
    await vault.put(identity.id, {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    });
    const response = await application.request(
      "https://wiki.example/imports",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { type: "google_docs", documentId: "legacy-document" },
        }),
      },
      workerEnv,
    );
    await vault.delete(identity.id);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sourceType: "google_docs",
      sourceLabel: "Google Document: legacy-document",
    });
  });

  it("reconciles a queued intent after Workflow creation fails", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ id: "workflow" });
    const environment = workflowEnvironment(create, "unknown");
    const response = await testApp().request(
      "https://wiki.example/imports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "deferred-workflow",
        },
        body: JSON.stringify({ sourceType: "markdown", filename: "note.md", content: "# Note" }),
      },
      environment,
    );
    await env.DB.prepare(
      "UPDATE imports SET updated_at = '2026-08-23T00:00:00.000Z'",
    ).run();

    const result = await reconcileQueuedImports(
      environment,
      new Date("2026-08-23T00:10:00.000Z"),
    );

    expect(response.status).toBe(202);
    expect(result).toEqual({ resumed: 1, failed: 0 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("sweeps only aged prefixes without a durable D1 intent", async () => {
    const liveId = "live-import";
    const orphanPrefix = `imports/${identity.workspaceId}/orphaned-import/`;
    const timestamp = "2026-08-23T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO imports (
         id, workspace_id, user_id, source_type, source_metadata_json,
         workflow_source_json, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'paste', '{}', NULL, 'running', ?4, ?4)`,
    )
      .bind(liveId, identity.workspaceId, identity.id, timestamp)
      .run();
    const liveKey = `imports/${identity.workspaceId}/${liveId}/source/note.md`;
    await Promise.all([
      env.FILES.put(liveKey, "live"),
      env.FILES.put(`${orphanPrefix}source/note.md`, "orphan"),
    ]);

    const removed = await cleanupOrphanedImportArtifacts(
      env,
      new Date(Date.now() + 25 * 60 * 60 * 1_000),
    );

    expect(removed).toBe(1);
    expect((await env.FILES.list({ prefix: orphanPrefix })).objects).toEqual([]);
    expect(await env.FILES.head(liveKey)).not.toBeNull();
  });
});

function testApp(): Hono<{
  Bindings: McpRuntimeEnv;
  Variables: { identity: AuthenticatedIdentity };
}> {
  const application = new Hono<{
    Bindings: McpRuntimeEnv;
    Variables: { identity: AuthenticatedIdentity };
  }>();
  application.use("*", async (context, next) => {
    context.set("identity", identity);
    await next();
  });
  application.route("/", createImportRoutes());
  return application;
}

function workflowEnvironment(
  create: ReturnType<typeof vi.fn>,
  status: "running" | "unknown",
): McpRuntimeEnv {
  return {
    ...env,
    IMPORT_WORKFLOW: {
      create,
      get: vi.fn(() =>
        Promise.resolve({
          status: () => Promise.resolve({ status }),
          restart: vi.fn(),
        }),
      ),
    },
  } as unknown as McpRuntimeEnv;
}
