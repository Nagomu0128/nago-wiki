import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupExpiredPortableExports,
  runWeeklyBackupMaintenance,
  startPortableExport,
} from "../../src/exports/service";
import {
  exportWorkflowParamsSchema,
  retentionExpiresAt,
} from "../../src/exports/workflow";
import type { McpRuntimeEnv } from "../../src/mcp/types";

const workspaceId = "backup-workspace";
const ownerId = "backup-owner";

describe("portable export service", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM exports"),
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM workspaces"),
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Backup', ?2)",
      ).bind(workspaceId, "2026-08-01T00:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO users (
           id, workspace_id, email, display_name, role, status,
           created_at, updated_at
         ) VALUES (?1, ?2, 'owner@example.com', 'Owner', 'owner', 'active', ?3, ?3)`,
      ).bind(ownerId, workspaceId, "2026-08-01T00:00:00.000Z"),
    ]);
  });

  it("retains downloads, weekly backups, and monthly representatives correctly", () => {
    const base = {
      exportId: "retention-export",
      workspaceId,
      requestedBy: ownerId,
    };
    expect(
      retentionExpiresAt(
        exportWorkflowParamsSchema.parse(base),
        new Date("2026-08-02T03:00:00.000Z"),
      ),
    ).toBe("2026-08-09T03:00:00.000Z");
    expect(
      retentionExpiresAt(
        exportWorkflowParamsSchema.parse({
          ...base,
          purpose: "backup",
          backupDate: "2026-08-09",
          retentionClass: "weekly",
        }),
        new Date("2026-08-09T03:00:00.000Z"),
      ),
    ).toBe("2026-11-07T03:00:00.000Z");
    expect(
      retentionExpiresAt(
        exportWorkflowParamsSchema.parse({
          ...base,
          purpose: "backup",
          backupDate: "2027-02-07",
          retentionClass: "monthly",
        }),
        new Date("2027-02-07T03:00:00.000Z"),
      ),
    ).toBe("2028-02-07T03:00:00.000Z");
  });

  it("creates only one resumable backup per workspace and date", async () => {
    const create = vi.fn(() => Promise.resolve({ id: "workflow" }));
    const get = vi.fn(() =>
      Promise.resolve({
        status: () => Promise.resolve({ status: "running" }),
        restart: vi.fn(),
      }),
    );
    const environment = {
      ...env,
      EXPORT_WORKFLOW: { create, get },
    } as unknown as McpRuntimeEnv;
    const input = {
      workspaceId,
      requestedBy: ownerId,
      purpose: "backup" as const,
      backupDate: "2026-08-02",
      retentionClass: "monthly" as const,
    };

    const first = await startPortableExport(environment, input);
    const replay = await startPortableExport(environment, input);

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ id: first.id, created: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT purpose, retention_class, backup_date FROM exports WHERE id = ?1",
      )
        .bind(first.id)
        .first(),
    ).toEqual({
      purpose: "backup",
      retention_class: "monthly",
      backup_date: "2026-08-02",
    });
  });

  it("selects annual retention for the first successful backup even mid-month", async () => {
    const create = vi.fn(() => Promise.resolve({ id: "workflow" }));
    const environment = {
      ...env,
      EXPORT_WORKFLOW: { create },
    } as unknown as McpRuntimeEnv;

    const result = await runWeeklyBackupMaintenance(
      environment,
      new Date("2026-08-15T18:00:00.000Z"),
    );

    expect(result).toMatchObject({ started: 1, resumed: 0, failed: 0 });
    expect(
      await env.DB.prepare(
        "SELECT backup_date, retention_class FROM exports WHERE purpose = 'backup'",
      ).first(),
    ).toEqual({ backup_date: "2026-08-16", retention_class: "monthly" });
  });

  it("durably queues all workspaces when one Workflow start is unavailable", async () => {
    const secondWorkspaceId = "z-backup-workspace";
    const secondOwnerId = "z-backup-owner";
    const timestamp = "2026-08-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Second', ?2)",
      ).bind(secondWorkspaceId, timestamp),
      env.DB.prepare(
        `INSERT INTO users (
           id, workspace_id, email, display_name, role, status,
           created_at, updated_at
         ) VALUES (?1, ?2, 'second@example.com', 'Second', 'owner', 'active', ?3, ?3)`,
      ).bind(secondOwnerId, secondWorkspaceId, timestamp),
    ]);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ id: "workflow" });
    const environment = {
      ...env,
      EXPORT_WORKFLOW: { create },
    } as unknown as McpRuntimeEnv;

    const result = await runWeeklyBackupMaintenance(
      environment,
      new Date("2026-08-15T18:00:00.000Z"),
    );

    expect(result).toMatchObject({ started: 2, failed: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM exports").first(),
    ).toEqual({ count: 2 });
  });

  it("removes expired artifacts even when their R2 keys were never persisted", async () => {
    const prefix = `backups/${workspaceId}/2026-01-04/`;
    await Promise.all([
      env.FILES.put(`${prefix}wiki-export.zip`, "archive"),
      env.FILES.put(`${prefix}plan.json`, "{}"),
      env.FILES.put(`${prefix}staging/00001.bin`, "stage"),
    ]);
    await env.DB.prepare(
      `INSERT INTO exports (
         id, workspace_id, user_id, purpose, retention_class, backup_date,
         status, created_at, updated_at, expires_at
       ) VALUES (
         'expired-backup', ?1, ?2, 'backup', 'weekly', '2026-01-04',
         'failed', ?3, ?3, ?4
       )`,
    )
      .bind(
        workspaceId,
        ownerId,
        "2026-01-04T00:00:00.000Z",
        "2026-04-04T00:00:00.000Z",
      )
      .run();

    const cleaned = await cleanupExpiredPortableExports(
      env,
      "2026-04-05T00:00:00.000Z",
    );

    expect(cleaned).toBe(1);
    expect((await env.FILES.list({ prefix })).objects).toHaveLength(0);
    expect(
      await env.DB.prepare(
        "SELECT status, r2_key, plan_r2_key FROM exports WHERE id = 'expired-backup'",
      ).first(),
    ).toEqual({ status: "cancelled", r2_key: null, plan_r2_key: null });
  });
});
