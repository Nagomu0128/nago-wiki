import { createUuidV7 } from "./ids";

export interface AuditEventInput {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export function createAuditEventStatement(
  database: D1Database,
  input: AuditEventInput,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events
         (id, actor_id, action, target_type, target_id, metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      createUuidV7(),
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? new Date().toISOString(),
    );
}

export async function recordAuditEvent(
  database: D1Database,
  input: AuditEventInput,
): Promise<void> {
  await createAuditEventStatement(database, input).run();
}
