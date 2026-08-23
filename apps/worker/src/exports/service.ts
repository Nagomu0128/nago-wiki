import { z } from "zod";

import {
  exportWorkflowParamsSchema,
  type ExportWorkflowParams,
} from "./workflow";
import { createUuidV7 } from "../core/ids";
import type { McpRuntimeEnv } from "../mcp/types";

export const WEEKLY_BACKUP_CRON = "0 18 * * 6";

export interface StartPortableExportInput {
  workspaceId: string;
  requestedBy: string;
  purpose?: "download" | "backup";
  backupDate?: string | null;
  retentionClass?: "weekly" | "monthly" | null;
}

export interface StartedPortableExport {
  id: string;
  status: "queued";
  created: boolean;
}

interface ExistingBackupRow {
  id: string;
  workspace_id: string;
  user_id: string;
  purpose: "backup";
  retention_class: "weekly" | "monthly";
  backup_date: string;
  status: "queued" | "running" | "ready" | "failed" | "cancelled";
}

interface ExpiredExportRow {
  id: string;
  r2_key: string | null;
  plan_r2_key: string | null;
}

interface WorkspaceOwnerRow {
  workspace_id: string;
  owner_id: string;
}

export async function startPortableExport(
  environment: McpRuntimeEnv,
  input: StartPortableExportInput,
): Promise<StartedPortableExport> {
  const parameters = exportWorkflowParamsSchema.parse({
    exportId: createUuidV7(),
    workspaceId: input.workspaceId,
    requestedBy: input.requestedBy,
    purpose: input.purpose ?? "download",
    backupDate: input.backupDate ?? null,
    retentionClass: input.retentionClass ?? null,
  });
  const now = new Date().toISOString();
  try {
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO exports (
           id, workspace_id, user_id, purpose, retention_class, backup_date,
           status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7)`,
      ).bind(
        parameters.exportId,
        parameters.workspaceId,
        parameters.requestedBy,
        parameters.purpose,
        parameters.retentionClass,
        parameters.backupDate,
        now,
      ),
      environment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_id, action, target_type, target_id, metadata_json, created_at
         ) VALUES (?1, ?2, ?3, 'export', ?4, ?5, ?6)`,
      ).bind(
        createUuidV7(),
        parameters.requestedBy,
        parameters.purpose === "backup" ? "backup.started" : "export.started",
        parameters.exportId,
        JSON.stringify({
          purpose: parameters.purpose,
          backupDate: parameters.backupDate,
          retentionClass: parameters.retentionClass,
        }),
        now,
      ),
    ]);
  } catch (error) {
    if (parameters.purpose !== "backup" || parameters.backupDate === null) {
      throw error;
    }
    const existing = await findBackup(
      environment.DB,
      parameters.workspaceId,
      parameters.backupDate,
    );
    if (existing === null) throw error;
    await ensureExportWorkflow(environment.EXPORT_WORKFLOW, rowParameters(existing));
    return { id: existing.id, status: "queued", created: false };
  }

  await createExportWorkflow(environment.EXPORT_WORKFLOW, parameters);
  return { id: parameters.exportId, status: "queued", created: true };
}

export async function runWeeklyBackupMaintenance(
  environment: McpRuntimeEnv,
  now = new Date(),
): Promise<{ started: number; resumed: number; cleaned: number }> {
  const backupDate = japanDate(now);
  const retentionClass = Number(backupDate.slice(8, 10)) <= 7
    ? "monthly"
    : "weekly";
  const owners = await environment.DB.prepare(
    `SELECT w.id AS workspace_id,
            (SELECT u.id FROM users u
              WHERE u.workspace_id = w.id
                AND u.role = 'owner' AND u.status = 'active'
              ORDER BY u.created_at, u.id LIMIT 1) AS owner_id
       FROM workspaces w
      WHERE EXISTS (
        SELECT 1 FROM users u
         WHERE u.workspace_id = w.id
           AND u.role = 'owner' AND u.status = 'active'
      )
      ORDER BY w.id`,
  ).all<WorkspaceOwnerRow>();
  let started = 0;
  let resumed = 0;
  for (const owner of owners.results) {
    const result = await startPortableExport(environment, {
      workspaceId: owner.workspace_id,
      requestedBy: owner.owner_id,
      purpose: "backup",
      backupDate,
      retentionClass,
    });
    if (result.created) started += 1;
    else resumed += 1;
  }
  const cleaned = await cleanupExpiredPortableExports(
    environment,
    now.toISOString(),
  );
  return { started, resumed, cleaned };
}

export async function cleanupExpiredPortableExports(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  now = new Date().toISOString(),
): Promise<number> {
  const rows = await environment.DB.prepare(
    `SELECT id, r2_key, plan_r2_key
       FROM exports
      WHERE expires_at IS NOT NULL AND expires_at <= ?1
        AND status IN ('ready', 'failed')
      ORDER BY expires_at, id
      LIMIT 100`,
  )
    .bind(now)
    .all<ExpiredExportRow>();
  for (const row of rows.results) {
    const artifactKey = row.r2_key ?? row.plan_r2_key;
    if (artifactKey !== null) {
      await deleteR2Prefix(environment.FILES, artifactPrefix(artifactKey));
    }
    await environment.DB.prepare(
      `UPDATE exports
          SET status = 'cancelled', r2_key = NULL, plan_r2_key = NULL,
              multipart_upload_id = NULL, updated_at = ?2
        WHERE id = ?1 AND expires_at IS NOT NULL AND expires_at <= ?2`,
    )
      .bind(row.id, now)
      .run();
  }
  return rows.results.length;
}

async function createExportWorkflow(
  workflow: Workflow<ExportWorkflowParams>,
  parameters: ExportWorkflowParams,
): Promise<void> {
  await workflow.create({
    id: `export-${parameters.exportId}`,
    params: parameters,
    retention: { successRetention: "30 days", errorRetention: "30 days" },
  });
}

async function ensureExportWorkflow(
  workflow: Workflow<ExportWorkflowParams>,
  parameters: ExportWorkflowParams,
): Promise<void> {
  const instance = await workflow.get(`export-${parameters.exportId}`);
  const state = await instance.status();
  if (state.status === "unknown") {
    try {
      await createExportWorkflow(workflow, parameters);
    } catch (error) {
      const raced = await (
        await workflow.get(`export-${parameters.exportId}`)
      ).status();
      if (raced.status === "unknown") throw error;
    }
  } else if (state.status === "errored" || state.status === "terminated") {
    await instance.restart();
  }
}

async function findBackup(
  database: D1Database,
  workspaceId: string,
  backupDate: string,
): Promise<ExistingBackupRow | null> {
  return database
    .prepare(
      `SELECT id, workspace_id, user_id, purpose, retention_class,
              backup_date, status
         FROM exports
        WHERE workspace_id = ?1 AND purpose = 'backup' AND backup_date = ?2`,
    )
    .bind(workspaceId, backupDate)
    .first<ExistingBackupRow>();
}

function rowParameters(row: ExistingBackupRow): ExportWorkflowParams {
  return exportWorkflowParamsSchema.parse({
    exportId: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.user_id,
    purpose: row.purpose,
    backupDate: row.backup_date,
    retentionClass: row.retention_class,
  });
}

function japanDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return z.iso.date().parse(`${get("year")}-${get("month")}-${get("day")}`);
}

function artifactPrefix(key: string): string {
  const slash = key.lastIndexOf("/");
  if (slash <= 0) throw new Error("Export artifact key is invalid");
  return key.slice(0, slash + 1);
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let objects: R2Objects;
  do {
    objects = await bucket.list({ prefix, limit: 1_000 });
    if (objects.objects.length > 0) {
      await bucket.delete(objects.objects.map((object) => object.key));
    }
  } while (objects.truncated || objects.objects.length > 0);
}
