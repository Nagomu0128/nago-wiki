import type { McpRuntimeEnv } from "../mcp/types";

const DEFAULT_IMPORT_BATCH = 10;
const DEFAULT_OBJECT_BATCH = 100;

interface ExpiredImportRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
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
    `SELECT imports.id, imports.workspace_id
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
      const stagingPrefix = `${prefix}assets/`;
      const listing = await environment.FILES.list({
        prefix: stagingPrefix,
        limit: objectBatch,
      });
      const fixedKeys = [
        `${prefix}source/document.json`,
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
        ...listing.objects
          .map((object) => object.key)
          .filter((key) => key.startsWith(stagingPrefix)),
      ];
      if (keys.length > 0) {
        await environment.FILES.delete(keys);
        result.deletedObjects += keys.length;
      }
      if (!listing.truncated) {
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
