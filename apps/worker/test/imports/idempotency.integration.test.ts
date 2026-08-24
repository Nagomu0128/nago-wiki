import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupOrphanedImportArtifacts,
  createImportRoutes,
  reconcileQueuedImports,
} from "../../src/imports/routes";
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

describe("POST /imports idempotency", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM portable_maintenance_state"),
      env.DB.prepare("DELETE FROM import_request_idempotency"),
      env.DB.prepare("DELETE FROM imports"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM workspaces"),
      env.DB.prepare(
        `INSERT INTO workspaces (id, name, created_at)
         VALUES (?1, 'Import test', ?2)`,
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

  it("replays the existing job and rejects a mismatched payload", async () => {
    const createWorkflow = vi.fn((options: { params: ImportWorkflowParams }) =>
      Promise.resolve({ id: options.params.importId }),
    );
    const workflowStatus = vi.fn(() => Promise.resolve({ status: "running" }));
    const getWorkflow = vi.fn(() =>
      Promise.resolve({ status: workflowStatus, restart: vi.fn() }),
    );
    const application = new Hono<{
      Bindings: McpRuntimeEnv;
      Variables: { identity: AuthenticatedIdentity };
    }>();
    application.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    application.route("/", createImportRoutes());
    const testEnvironment = {
      ...env,
      IMPORT_WORKFLOW: { create: createWorkflow, get: getWorkflow },
    } as unknown as McpRuntimeEnv;

    const create = (content: string) =>
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
        testEnvironment,
      );

    const first = await create("same memo");
    const replay = await create("same memo");
    const conflict = await create("different memo");

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: (await first.json<{ id: string }>()).id,
      status: "queued",
    });
    expect(conflict.status).toBe(409);
    expect(createWorkflow).toHaveBeenCalledTimes(1);
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM imports").first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
  });

  it("starts a missing workflow when an idempotent request is replayed", async () => {
    const createWorkflow = vi.fn(() => Promise.resolve({ id: "workflow" }));
    const workflowStatus = vi.fn(() => Promise.resolve({ status: "unknown" }));
    const application = new Hono<{
      Bindings: McpRuntimeEnv;
      Variables: { identity: AuthenticatedIdentity };
    }>();
    application.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    application.route("/", createImportRoutes());
    const testEnvironment = {
      ...env,
      IMPORT_WORKFLOW: {
        create: createWorkflow,
        get: vi.fn(() =>
          Promise.resolve({ status: workflowStatus, restart: vi.fn() }),
        ),
      },
    } as unknown as McpRuntimeEnv;
    const request = () =>
      application.request(
        "https://wiki.example/imports",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "recover-import-workflow",
          },
          body: JSON.stringify({ sourceType: "paste", content: "memo" }),
        },
        testEnvironment,
      );

    expect((await request()).status).toBe(202);
    expect((await request()).status).toBe(200);
    expect(createWorkflow).toHaveBeenCalledTimes(2);
  });

  it("requires a bounded Idempotency-Key", async () => {
    const application = new Hono<{
      Bindings: McpRuntimeEnv;
      Variables: { identity: AuthenticatedIdentity };
    }>();
    application.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    application.route("/", createImportRoutes());

    const response = await application.request(
      "https://wiki.example/imports",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: "paste", content: "memo" }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it("reconciles a durable import intent after Workflow creation fails", async () => {
    const createWorkflow = vi
      .fn()
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ id: "workflow" });
    const application = new Hono<{
      Bindings: McpRuntimeEnv;
      Variables: { identity: AuthenticatedIdentity };
    }>();
    application.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    application.route("/", createImportRoutes());
    const testEnvironment = {
      ...env,
      IMPORT_WORKFLOW: {
        create: createWorkflow,
        get: vi.fn(() =>
          Promise.resolve({
            status: () => Promise.resolve({ status: "unknown" }),
            restart: vi.fn(),
          }),
        ),
      },
    } as unknown as McpRuntimeEnv;

    const response = await application.request(
      "https://wiki.example/imports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "deferred-workflow",
        },
        body: JSON.stringify({ sourceType: "paste", content: "memo" }),
      },
      testEnvironment,
    );
    await env.DB.prepare(
      "UPDATE imports SET updated_at = '2026-08-23T00:00:00.000Z'",
    ).run();
    await env.DB.prepare(
      `INSERT INTO imports (
         id, workspace_id, user_id, source_type, source_metadata_json,
         workflow_source_json, status, created_at, updated_at
       ) VALUES (
         'legacy-queued-import', ?1, ?2, 'paste', '{}', NULL, 'running', ?3, ?3
       )`,
    )
      .bind(identity.workspaceId, identity.id, "2026-08-23T00:00:00.000Z")
      .run();

    const result = await reconcileQueuedImports(
      testEnvironment,
      new Date("2026-08-23T00:10:00.000Z"),
    );

    expect(response.status).toBe(202);
    expect(result).toEqual({ resumed: 1, failed: 1 });
    expect(createWorkflow).toHaveBeenCalledTimes(2);
    const legacyRow = await env.DB.prepare(
      "SELECT status, expires_at FROM imports WHERE id = 'legacy-queued-import'",
    ).first<{ status: string; expires_at: string | null }>();
    expect(legacyRow?.status).toBe("failed");
    expect(legacyRow?.expires_at).toEqual(expect.any(String));
  });

  it("preserves the winning R2 source when a committed D1 batch response is lost", async () => {
    const application = new Hono<{
      Bindings: McpRuntimeEnv;
      Variables: { identity: AuthenticatedIdentity };
    }>();
    application.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    application.route("/", createImportRoutes());
    const createWorkflow = vi.fn((options: { params: ImportWorkflowParams }) =>
      Promise.resolve({ id: options.params.importId }),
    );
    const database = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch(statements);
        throw new Error("D1 response lost after commit");
      },
    } as unknown as D1Database;
    const testEnvironment = {
      ...env,
      DB: database,
      IMPORT_WORKFLOW: {
        create: createWorkflow,
        get: vi.fn(() =>
          Promise.resolve({
            status: () => Promise.resolve({ status: "unknown" }),
            restart: vi.fn(),
          }),
        ),
      },
    } as unknown as McpRuntimeEnv;

    const response = await application.request(
      "https://wiki.example/imports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "lost-d1-response",
        },
        body: JSON.stringify({ sourceType: "paste", content: "keep me" }),
      },
      testEnvironment,
    );
    const parameters = createWorkflow.mock.calls[0]?.[0]?.params;
    const sourceKey =
      parameters?.source.sourceType === "paste"
        ? parameters.source.sourceKey
        : undefined;

    expect(response.status).toBe(200);
    expect(sourceKey).toBeDefined();
    expect(await env.FILES.head(sourceKey ?? "")).not.toBeNull();
  });

  it("sweeps only aged import prefixes that have no durable D1 intent", async () => {
    const orphanPrefix = `imports/${identity.workspaceId}/orphaned-import/`;
    const timestamp = "2026-08-23T00:00:00.000Z";
    const liveIds = Array.from(
      { length: 100 },
      (_, index) => `live-${String(index).padStart(3, "0")}`,
    );
    await env.DB.batch(
      liveIds.map((id) =>
        env.DB.prepare(
          `INSERT INTO imports (
             id, workspace_id, user_id, source_type, source_metadata_json,
             workflow_source_json, status, created_at, updated_at
           ) VALUES (?1, ?2, ?3, 'paste', '{}', NULL, 'running', ?4, ?4)`,
        ).bind(id, identity.workspaceId, identity.id, timestamp),
      ),
    );
    await Promise.all([
      ...liveIds.map((id) =>
        env.FILES.put(
          `imports/${identity.workspaceId}/${id}/source/note.md`,
          "live",
        ),
      ),
      env.FILES.put(`${orphanPrefix}source/note.md`, "orphan"),
    ]);

    const removed = await cleanupOrphanedImportArtifacts(
      env,
      new Date(Date.now() + 25 * 60 * 60 * 1_000),
    );

    expect(removed).toBe(1);
    expect((await env.FILES.list({ prefix: orphanPrefix })).objects).toEqual(
      [],
    );
    expect(
      await env.FILES.head(
        `imports/${identity.workspaceId}/${liveIds[0] ?? ""}/source/note.md`,
      ),
    ).not.toBeNull();
  });

  it("carries the R2 cursor across bounded scan pages", async () => {
    const timestamp = "2026-08-23T00:00:00.000Z";
    const liveId = "cursor-live-import";
    const orphanId = "cursor-orphan-import";
    const liveKey = `imports/${identity.workspaceId}/${liveId}/source/note.md`;
    const orphanKey = `imports/${identity.workspaceId}/${orphanId}/source/note.md`;
    await env.DB.prepare(
      `INSERT INTO imports (
         id, workspace_id, user_id, source_type, source_metadata_json,
         workflow_source_json, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'paste', '{}', NULL, 'running', ?4, ?4)`,
    )
      .bind(liveId, identity.workspaceId, identity.id, timestamp)
      .run();
    await Promise.all([env.FILES.put(liveKey, "live"), env.FILES.put(orphanKey, "orphan")]);
    const objects = await env.FILES.list({
      prefix: `imports/${identity.workspaceId}/`,
    });
    const live = objects.objects.find((object) => object.key === liveKey);
    const orphan = objects.objects.find((object) => object.key === orphanKey);
    if (live === undefined || orphan === undefined) {
      throw new Error("Missing cursor sweep fixtures");
    }
    const list = vi.fn((options: R2ListOptions) => {
      if (options.prefix === "imports/") {
        if (options.cursor === undefined) {
          return Promise.resolve({
            objects: [live],
            truncated: true,
            cursor: "cursor-page-2",
          });
        }
        if (options.cursor === "cursor-page-2") {
          return Promise.resolve({ objects: [orphan], truncated: false });
        }
      }
      if (options.prefix === `imports/${identity.workspaceId}/${orphanId}/`) {
        return Promise.resolve({ objects: [orphan], truncated: false });
      }
      return Promise.reject(
        new Error(`Unexpected R2 list: ${JSON.stringify(options)}`),
      );
    });
    const files = {
      list,
      delete: env.FILES.delete.bind(env.FILES),
    } as unknown as R2Bucket;

    const removed = await cleanupOrphanedImportArtifacts(
      { DB: env.DB, FILES: files },
      new Date(Date.now() + 25 * 60 * 60 * 1_000),
    );

    expect(removed).toBe(1);
    expect(list.mock.calls.slice(0, 2).map(([options]) => options.cursor)).toEqual([
      undefined,
      "cursor-page-2",
    ]);
    expect(await env.FILES.head(orphanKey)).toBeNull();
  });

  it("leaves recent orphan artifacts inside the ambiguity grace period", async () => {
    const prefix = `imports/${identity.workspaceId}/recent-orphan/`;
    const key = `${prefix}source/note.md`;
    await env.FILES.put(key, "recent");

    const removed = await cleanupOrphanedImportArtifacts(env, new Date());

    expect(removed).toBe(0);
    expect(await env.FILES.head(key)).not.toBeNull();
  });
});
