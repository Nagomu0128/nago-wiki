import type { McpRuntimeEnv } from "../mcp/types";

const DEFAULT_IMPORT_BATCH = 10;
const DEFAULT_OBJECT_BATCH = 100;
const MAX_ORPHAN_SCAN_PAGES = 5;
const MAX_ORPHAN_PREFIXES_PER_RUN = 100;
const IMPORT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
const IMPORT_ORPHAN_SWEEP_TASK = "import-orphan-sweep";

interface ExpiredImportRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  source_metadata_json: string;
}

interface CleanupOptions {
  importBatch?: number;
  objectBatch?: number;
  now?: Date;
}

export interface ImportCleanupResult {
  inspected: number;
  completed: number;
  deletedObjects: number;
  failed: number;
}

export async function cleanupExpiredImports(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  options: CleanupOptions = {},
): Promise<ImportCleanupResult> {
  const importBatch = boundedInteger(options.importBatch, DEFAULT_IMPORT_BATCH, 1, 25);
  const objectBatch = boundedInteger(options.objectBatch, DEFAULT_OBJECT_BATCH, 1, 500);
  const now = (options.now ?? new Date()).toISOString();
  const rows = await environment.DB.prepare(
    `SELECT imports.id, imports.workspace_id, imports.source_metadata_json
       FROM imports
       LEFT JOIN import_cleanup ON import_cleanup.import_id = imports.id
       LEFT JOIN import_applications
         ON import_applications.import_id = imports.id
        AND import_applications.status = 'applying'
      WHERE imports.expires_at IS NOT NULL
        AND imports.expires_at <= ?1
        AND import_cleanup.import_id IS NULL
        AND import_applications.import_id IS NULL
      ORDER BY imports.expires_at, imports.id
      LIMIT ?2`,
  )
    .bind(now, importBatch)
    .all<ExpiredImportRow>();

  const result: ImportCleanupResult = {
    inspected: rows.results.length,
    completed: 0,
    deletedObjects: 0,
    failed: 0,
  };
  for (const row of rows.results) {
    try {
      const prefix = importPrefix(row.workspace_id, row.id);
      const [sourceListing, stagingListing] = await Promise.all([
        environment.FILES.list({ prefix: `${prefix}source/`, limit: objectBatch }),
        environment.FILES.list({ prefix: `${prefix}assets/`, limit: objectBatch }),
      ]);
      const fixedKeys = [
        `${prefix}preview.md`,
        `${prefix}report.json`,
      ];
      const fixedObjects = await Promise.all(
        fixedKeys.map(async (key) => ({ key, object: await environment.FILES.head(key) })),
      );
      const keys = [
        ...fixedObjects
          .filter(({ object }) => object !== null)
          .map(({ key }) => key),
        ...sourceListing.objects.map((object) => object.key),
        ...stagingListing.objects.map((object) => object.key),
      ];
      if (keys.length > 0) {
        await environment.FILES.delete(keys);
        result.deletedObjects += keys.length;
      }
      if (!sourceListing.truncated && !stagingListing.truncated) {
        await environment.DB.prepare(
          `INSERT OR IGNORE INTO import_cleanup (import_id, completed_at)
           VALUES (?1, ?2)`,
        )
          .bind(row.id, now)
          .run();
        result.completed += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error(JSON.stringify({
        message: "Expired import cleanup failed",
        importId: row.id,
        error: publicCleanupError(error),
      }));
    }
  }
  return result;
}

export async function cleanupOrphanedImportArtifacts(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  now = new Date(),
): Promise<number> {
  const cutoff = now.getTime() - IMPORT_ORPHAN_GRACE_MS;
  const state = await environment.DB.prepare(
    "SELECT cursor FROM portable_maintenance_state WHERE task = ?1",
  )
    .bind(IMPORT_ORPHAN_SWEEP_TASK)
    .first<{ cursor: string | null }>();
  let cursor = state?.cursor ?? undefined;
  let removed = 0;
  for (let page = 0; page < MAX_ORPHAN_SCAN_PAGES; page += 1) {
    const pageCursor = cursor;
    let listing: R2Objects;
    try {
      listing = await environment.FILES.list({
        prefix: "imports/",
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      if (cursor === undefined) throw error;
      cursor = undefined;
      await storeMaintenanceCursor(environment.DB, undefined, now);
      continue;
    }
    const candidates = new Map<
      string,
      { workspaceId: string; importId: string }
    >();
    for (const object of listing.objects) {
      if (object.uploaded.getTime() > cutoff) continue;
      const parsed = parseImportArtifactKey(object.key);
      if (parsed !== null) candidates.set(parsed.prefix, parsed);
    }
    for (const [prefix, candidate] of candidates) {
      const row = await environment.DB.prepare(
        "SELECT id FROM imports WHERE id = ?1 AND workspace_id = ?2",
      )
        .bind(candidate.importId, candidate.workspaceId)
        .first<{ id: string }>();
      if (row !== null) continue;
      const deletion = await deleteOldOrphanBatch(
        environment.FILES,
        prefix,
        cutoff,
      );
      if (!deletion.deleted) continue;
      if (!deletion.complete) {
        await storeMaintenanceCursor(environment.DB, pageCursor, now);
        return removed;
      }
      removed += 1;
      if (removed >= MAX_ORPHAN_PREFIXES_PER_RUN) {
        await storeMaintenanceCursor(environment.DB, pageCursor, now);
        return removed;
      }
    }
    cursor = listing.truncated ? listing.cursor : undefined;
    await storeMaintenanceCursor(environment.DB, cursor, now);
    if (cursor === undefined) break;
  }
  return removed;
}

async function deleteOldOrphanBatch(
  bucket: R2Bucket,
  prefix: string,
  cutoff: number,
): Promise<{ deleted: boolean; complete: boolean }> {
  const listing = await bucket.list({ prefix, limit: 500 });
  if (listing.objects.length === 0) return { deleted: false, complete: true };
  if (listing.objects.some((object) => object.uploaded.getTime() > cutoff)) {
    return { deleted: false, complete: true };
  }
  await bucket.delete(listing.objects.map((object) => object.key));
  return { deleted: true, complete: !listing.truncated };
}

async function storeMaintenanceCursor(
  database: D1Database,
  cursor: string | undefined,
  now: Date,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO portable_maintenance_state (task, cursor, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(task) DO UPDATE
         SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .bind(IMPORT_ORPHAN_SWEEP_TASK, cursor ?? null, now.toISOString())
    .run();
}

function parseImportArtifactKey(
  key: string,
): { prefix: string; workspaceId: string; importId: string } | null {
  const segments = key.split("/");
  const workspaceId = segments[1];
  const importId = segments[2];
  if (
    segments[0] !== "imports" ||
    workspaceId === undefined ||
    workspaceId.length === 0 ||
    importId === undefined ||
    importId.length === 0 ||
    segments.length < 4
  ) {
    return null;
  }
  return {
    prefix: `imports/${workspaceId}/${importId}/`,
    workspaceId,
    importId,
  };
}

function importPrefix(workspaceId: string, importId: string): string {
  return `imports/${workspaceId}/${importId}/`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value === undefined || !Number.isInteger(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, value));
}

function publicCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : "cleanup failed";
  return message.replace(/https?:\/\/\S+/giu, "[redacted URL]").slice(0, 300);
}
