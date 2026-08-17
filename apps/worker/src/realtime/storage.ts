import * as Y from "yjs";

const QUIET_FLUSH_MS = 2_000;
const MAX_DIRTY_MS = 15_000;
const MAX_RETRY_MS = 60_000;

interface RoomMetaRow extends Record<string, SqlStorageValue> {
  workspace_id: string | null;
  page_id: string | null;
  base_revision: number;
  snapshot_sequence: number;
  dirty: number;
  first_dirty_at: number | null;
  last_update_at: number | null;
  next_flush_at: number | null;
  retry_count: number;
  initialized: number;
}

interface SnapshotRow extends Record<string, SqlStorageValue> {
  sequence: number;
  snapshot: ArrayBuffer;
}

interface UpdateRow extends Record<string, SqlStorageValue> {
  sequence: number;
  update_blob: ArrayBuffer;
}

export interface RoomMeta {
  workspaceId: string | null;
  pageId: string | null;
  baseRevision: number;
  snapshotSequence: number;
  dirty: boolean;
  firstDirtyAt: number | null;
  lastUpdateAt: number | null;
  nextFlushAt: number | null;
  retryCount: number;
  initialized: boolean;
}

export interface PendingFlush {
  throughSequence: number;
  snapshot: Uint8Array;
  bodyMarkdown: string;
  baseRevision: number;
}

export interface FlushCompletion {
  nextFlushAt: number | null;
  hasPendingUpdates: boolean;
}

export function computeFlushDeadline(
  firstDirtyAt: number,
  lastUpdateAt: number,
): number {
  return Math.min(lastUpdateAt + QUIET_FLUSH_MS, firstDirtyAt + MAX_DIRTY_MS);
}

export function computeRetryAt(now: number, retryCount: number): number {
  const delay = Math.min(2 ** Math.max(0, retryCount) * 1_000, MAX_RETRY_MS);
  return now + delay;
}

export function restoreYDoc(
  snapshot: Uint8Array | null,
  updates: readonly Uint8Array[],
): Y.Doc {
  const doc = new Y.Doc();
  if (snapshot !== null) {
    Y.applyUpdate(doc, snapshot);
  }
  for (const update of updates) {
    Y.applyUpdate(doc, update);
  }
  return doc;
}

export function createCompactionSnapshot(
  snapshot: Uint8Array | null,
  updates: readonly Uint8Array[],
): Uint8Array {
  return Y.encodeStateAsUpdate(restoreYDoc(snapshot, updates));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class PageRoomStorage {
  private readonly sql: SqlStorage;

  public constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  public initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        workspace_id TEXT,
        page_id TEXT,
        base_revision INTEGER NOT NULL DEFAULT 0,
        snapshot_sequence INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        first_dirty_at INTEGER,
        last_update_at INTEGER,
        next_flush_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL DEFAULT 0,
        initialized INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS y_snapshots (
        sequence INTEGER PRIMARY KEY,
        snapshot BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS y_updates (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_sequence INTEGER NOT NULL,
        update_blob BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_y_updates_snapshot_sequence
        ON y_updates(snapshot_sequence, sequence);
      INSERT OR IGNORE INTO room_meta(id) VALUES (1);
    `);
  }

  public restoreInto(doc: Y.Doc): void {
    const snapshot = this.sql
      .exec<SnapshotRow>(
        "SELECT sequence, snapshot FROM y_snapshots ORDER BY sequence DESC LIMIT 1",
      )
      .toArray()[0];
    if (snapshot !== undefined) {
      Y.applyUpdate(doc, new Uint8Array(snapshot.snapshot));
    }

    const afterSequence = snapshot?.sequence ?? 0;
    const updates = this.sql
      .exec<UpdateRow>(
        "SELECT sequence, update_blob FROM y_updates WHERE sequence > ? ORDER BY sequence",
        afterSequence,
      )
      .toArray();
    for (const update of updates) {
      Y.applyUpdate(doc, new Uint8Array(update.update_blob));
    }
  }

  public getMeta(): RoomMeta {
    const row = this.sql.exec<RoomMetaRow>("SELECT * FROM room_meta WHERE id = 1").one();
    return {
      workspaceId: row.workspace_id,
      pageId: row.page_id,
      baseRevision: row.base_revision,
      snapshotSequence: row.snapshot_sequence,
      dirty: row.dirty === 1,
      firstDirtyAt: row.first_dirty_at,
      lastUpdateAt: row.last_update_at,
      nextFlushAt: row.next_flush_at,
      retryCount: row.retry_count,
      initialized: row.initialized === 1,
    };
  }

  public ensureIdentity(workspaceId: string, pageId: string): boolean {
    const meta = this.getMeta();
    if (meta.workspaceId === null && meta.pageId === null) {
      this.sql.exec(
        "UPDATE room_meta SET workspace_id = ?, page_id = ? WHERE id = 1",
        workspaceId,
        pageId,
      );
      return true;
    }
    return meta.workspaceId === workspaceId && meta.pageId === pageId;
  }

  public initializeFromMarkdown(
    doc: Y.Doc,
    bodyMarkdown: string,
    baseRevision: number,
    now: number,
  ): boolean {
    return this.storage.transactionSync(() => {
      const meta = this.getMeta();
      if (!meta.initialized) {
        const seed = new Y.Doc();
        if (bodyMarkdown.length > 0) {
          seed.getText("markdown").insert(0, bodyMarkdown);
        }
        const snapshot = Y.encodeStateAsUpdate(seed);
        this.sql.exec(
          "INSERT OR REPLACE INTO y_snapshots(sequence, snapshot, created_at) VALUES (0, ?, ?)",
          asArrayBuffer(snapshot),
          now,
        );
        this.sql.exec(
          `UPDATE room_meta
           SET base_revision = ?, initialized = 1, last_activity_at = ?
           WHERE id = 1`,
          baseRevision,
          now,
        );
        Y.applyUpdate(doc, snapshot);
        return true;
      }
      return false;
    });
  }

  public persistUpdate(update: Uint8Array, now: number): {
    sequence: number;
    nextFlushAt: number;
  } {
    return this.storage.transactionSync(() => {
      const meta = this.getMeta();
      const firstDirtyAt = meta.dirty ? (meta.firstDirtyAt ?? now) : now;
      const nextFlushAt = computeFlushDeadline(firstDirtyAt, now);
      const sequence = this.sql
        .exec<{ sequence: number }>(
          `INSERT INTO y_updates(snapshot_sequence, update_blob, created_at)
           VALUES (?, ?, ?) RETURNING sequence`,
          meta.snapshotSequence,
          asArrayBuffer(update),
          now,
        )
        .one().sequence;
      this.sql.exec(
        `UPDATE room_meta
         SET dirty = 1, first_dirty_at = ?, last_update_at = ?,
             next_flush_at = ?, retry_count = 0, last_activity_at = ?, initialized = 1
         WHERE id = 1`,
        firstDirtyAt,
        now,
        nextFlushAt,
        now,
      );
      return { sequence, nextFlushAt };
    });
  }

  public prepareFlush(doc: Y.Doc): PendingFlush | null {
    const meta = this.getMeta();
    if (!meta.dirty) {
      return null;
    }
    const sequenceRow = this.sql
      .exec<{ sequence: number | null }>(
        "SELECT MAX(sequence) AS sequence FROM y_updates",
      )
      .one();
    return {
      throughSequence: sequenceRow.sequence ?? meta.snapshotSequence,
      snapshot: Y.encodeStateAsUpdate(doc),
      bodyMarkdown: doc.getText("markdown").toJSON(),
      baseRevision: meta.baseRevision,
    };
  }

  public completeFlush(
    pending: PendingFlush,
    newRevision: number,
    now: number,
  ): FlushCompletion {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT OR REPLACE INTO y_snapshots(sequence, snapshot, created_at) VALUES (?, ?, ?)",
        pending.throughSequence,
        asArrayBuffer(pending.snapshot),
        now,
      );
      this.sql.exec(
        "DELETE FROM y_updates WHERE sequence <= ?",
        pending.throughSequence,
      );
      this.sql.exec(
        "DELETE FROM y_snapshots WHERE sequence < ?",
        pending.throughSequence,
      );

      const pendingTimes = this.sql
        .exec<{ first_at: number | null; last_at: number | null }>(
          `SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at
           FROM y_updates WHERE sequence > ?`,
          pending.throughSequence,
        )
        .one();
      const firstPendingAt = pendingTimes.first_at;
      const lastPendingAt = pendingTimes.last_at;
      const hasPendingUpdates =
        firstPendingAt !== null && lastPendingAt !== null;
      const nextFlushAt =
        firstPendingAt !== null && lastPendingAt !== null
          ? computeFlushDeadline(firstPendingAt, lastPendingAt)
          : null;
      this.sql.exec(
        `UPDATE room_meta
         SET base_revision = ?, snapshot_sequence = ?, dirty = ?,
             first_dirty_at = ?, last_update_at = ?, next_flush_at = ?,
             retry_count = 0, last_activity_at = ?
         WHERE id = 1`,
        newRevision,
        pending.throughSequence,
        hasPendingUpdates ? 1 : 0,
        pendingTimes.first_at,
        pendingTimes.last_at,
        nextFlushAt,
        now,
      );
      return { nextFlushAt, hasPendingUpdates };
    });
  }

  public recordConflict(currentRevision: number, now: number): number {
    const meta = this.getMeta();
    const retryCount = meta.retryCount + 1;
    const nextFlushAt = computeRetryAt(now, retryCount - 1);
    this.sql.exec(
      `UPDATE room_meta
       SET base_revision = ?, retry_count = ?, next_flush_at = ?
       WHERE id = 1`,
      currentRevision,
      retryCount,
      nextFlushAt,
    );
    return nextFlushAt;
  }

  public recordFlushFailure(now: number): number {
    const meta = this.getMeta();
    const retryCount = meta.retryCount + 1;
    const nextFlushAt = computeRetryAt(now, retryCount - 1);
    this.sql.exec(
      "UPDATE room_meta SET retry_count = ?, next_flush_at = ? WHERE id = 1",
      retryCount,
      nextFlushAt,
    );
    return nextFlushAt;
  }
}
