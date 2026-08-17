import type { PersistVersionJob } from "./contracts";

interface VersionOutboxRow {
  version_id: string;
  body_md: string;
  r2_key: string;
  content_hash: string;
}

export async function persistPageVersion(
  database: D1Database,
  files: R2Bucket,
  job: PersistVersionJob,
): Promise<void> {
  const value = await database
    .prepare(
      `SELECT outbox.version_id, outbox.body_md, versions.r2_key, versions.content_hash
         FROM page_version_outbox AS outbox
         JOIN page_versions AS versions ON versions.id = outbox.version_id
        WHERE outbox.version_id = ?1`,
    )
    .bind(job.versionId)
    .first<VersionOutboxRow>();
  if (value === null) return;
  if ((await sha256Hex(value.body_md)) !== value.content_hash) {
    throw new Error("Version outbox content hash mismatch");
  }

  try {
    await files.put(value.r2_key, value.body_md, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        version_id: value.version_id,
        content_hash: value.content_hash,
      },
    });
    await database.batch([
      database
        .prepare(
          `UPDATE page_versions
              SET storage_status = 'ready', storage_error = NULL
            WHERE id = ?1`,
        )
        .bind(value.version_id),
      database
        .prepare(`DELETE FROM page_version_outbox WHERE version_id = ?1`)
        .bind(value.version_id),
    ]);
  } catch (error) {
    await database.batch([
      database
        .prepare(
          `UPDATE page_versions
              SET storage_status = 'failed', storage_error = ?2
            WHERE id = ?1`,
        )
        .bind(value.version_id, errorMessage(error)),
      database
        .prepare(
          `UPDATE page_version_outbox
              SET attempts = attempts + 1,
                  available_at = ?2,
                  updated_at = ?3
            WHERE version_id = ?1`,
        )
        .bind(
          value.version_id,
          new Date(Date.now() + 60_000).toISOString(),
          new Date().toISOString(),
        ),
    ]);
    throw error;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "Version write failed";
}
