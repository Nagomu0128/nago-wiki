import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createImportRoutes } from "../../src/imports/routes";
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
  });

  it("replays the existing job and rejects a mismatched payload", async () => {
    const createWorkflow = vi.fn(async () => ({ id: "workflow" }));
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
      IMPORT_WORKFLOW: { create: createWorkflow },
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
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM imports").first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
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
      { ...env } as unknown as McpRuntimeEnv,
    );

    expect(response.status).toBe(400);
  });
});
