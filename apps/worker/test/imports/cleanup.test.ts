import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredImports } from "../../src/imports/cleanup";
import { createUuidV7 } from "../../src/core/ids";
import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";

describe("expired import cleanup", () => {
  let userId: string;

  beforeEach(async () => {
    await env.DB.exec(`
      DELETE FROM import_cleanup;
      DELETE FROM import_applications;
      DELETE FROM imports;
    `);
    userId = createUuidV7();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Cleanup owner', 'owner', 'active', ?4, ?4)`,
    )
      .bind(userId, DEFAULT_WORKSPACE_ID, `${userId}@example.com`, now)
      .run();
  });

  it("deletes only source, preview, report, and bounded staging objects", async () => {
    const importId = crypto.randomUUID();
    const prefix = `imports/${DEFAULT_WORKSPACE_ID}/${importId}/`;
    const finalKey = `assets/${DEFAULT_WORKSPACE_ID}/${createUuidV7()}/asset/image.png`;
    const now = new Date("2026-08-24T00:00:00.000Z");
    await env.DB.prepare(
      `INSERT INTO imports
         (id, workspace_id, user_id, source_type, source_metadata_json, status,
          created_at, updated_at, expires_at)
       VALUES (?1, ?2, ?3, 'google_docs', '{}', 'failed', ?4, ?4, ?5)`,
    )
      .bind(importId, DEFAULT_WORKSPACE_ID, userId, now.toISOString(), "2026-08-16T00:00:00.000Z")
      .run();
    await Promise.all([
      env.FILES.put(`${prefix}source/document.json`, "{}"),
      env.FILES.put(`${prefix}preview.md`, "preview"),
      env.FILES.put(`${prefix}report.json`, "{}"),
      env.FILES.put(`${prefix}assets/one/image.png`, "staging-one"),
      env.FILES.put(`${prefix}assets/two/image.png`, "staging-two"),
      env.FILES.put(`${prefix}audit/keep.json`, "unrelated"),
      env.FILES.put(finalKey, "final"),
    ]);

    const first = await cleanupExpiredImports(env, {
      now,
      importBatch: 1,
      objectBatch: 1,
    });
    expect(first.deletedObjects).toBe(4);
    expect(first.completed).toBe(0);

    const second = await cleanupExpiredImports(env, {
      now,
      importBatch: 1,
      objectBatch: 1,
    });
    expect(second.deletedObjects).toBe(1);
    expect(second.completed).toBe(1);
    expect(await env.FILES.get(finalKey)).not.toBeNull();
    expect(await env.FILES.get(`${prefix}audit/keep.json`)).not.toBeNull();
    expect((await env.FILES.list({ prefix: `${prefix}assets/` })).objects).toEqual([]);
  });
});
