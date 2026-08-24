import type { McpRuntimeEnv } from "../mcp/types";
import { createUuidV7 } from "../core/ids";

interface LinkCodeRow {
  id: string;
  user_id: string;
  provider: string | null;
}

interface ExternalIdentityRow {
  user_id: string;
}

interface LinkedIdentityRow extends ExternalIdentityRow {
  provider: "discord" | "line";
  external_subject: string;
  linked_at: string;
}

export async function issueAccountLinkCode(
  database: D1Database,
  userId: string,
  provider: "discord" | "line" | null,
): Promise<{ code: string; expiresAt: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const code = base64Url(bytes);
  const hash = await sha256Hex(code);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
  await database
    .prepare(
      `INSERT INTO account_link_codes
         (id, user_id, code_hash, provider, expires_at, consumed_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
    )
    .bind(id, userId, hash, provider, expiresAt, createdAt)
    .run();
  return { code, expiresAt };
}

export async function consumeAccountLinkCode(
  database: D1Database,
  provider: "discord" | "line",
  externalSubject: string,
  code: string,
  workspaceId: string,
): Promise<boolean> {
  const hash = await sha256Hex(code.trim());
  const linkCode = await database
    .prepare(
        `SELECT codes.id, codes.user_id, codes.provider
           FROM account_link_codes AS codes
           JOIN users ON users.id = codes.user_id
          WHERE codes.code_hash = ?1
            AND codes.consumed_at IS NULL
            AND codes.expires_at > ?2
            AND (codes.provider IS NULL OR codes.provider = ?3)
            AND users.workspace_id = ?4
            AND users.status = 'active'`,
      )
    .bind(hash, new Date().toISOString(), provider, workspaceId)
    .first<LinkCodeRow>();
  if (linkCode === null) return false;

  const existing = await database
    .prepare(
      `SELECT user_id FROM external_identities
        WHERE provider = ?1 AND external_subject = ?2`,
    )
    .bind(provider, externalSubject)
    .first<ExternalIdentityRow>();
  if (existing !== null && existing.user_id !== linkCode.user_id) return false;

  const marker = `${new Date().toISOString()}#${crypto.randomUUID()}`;
  const linkedAt = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE account_link_codes SET consumed_at = ?2
          WHERE id = ?1 AND consumed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM users
               WHERE users.id = account_link_codes.user_id
                 AND users.workspace_id = ?3
                 AND users.status = 'active'
            )`,
      )
      .bind(linkCode.id, marker, workspaceId),
    database
      .prepare(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, metadata_json, created_at)
         SELECT ?1, user_id, 'bot_identity.linked', 'user', user_id, ?2, ?3
           FROM account_link_codes
          WHERE id = ?4 AND consumed_at = ?5
            AND NOT EXISTS (
              SELECT 1
                FROM external_identities
               WHERE provider = ?6 AND external_subject = ?7
            )`,
      )
      .bind(
        createUuidV7(),
        JSON.stringify({ provider }),
        linkedAt,
        linkCode.id,
        marker,
        provider,
        externalSubject,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO external_identities
           (provider, external_subject, user_id, linked_at)
         SELECT ?1, ?2, user_id, ?3
           FROM account_link_codes
          WHERE id = ?4 AND consumed_at = ?5`,
      )
      .bind(provider, externalSubject, linkedAt, linkCode.id, marker),
  ]);
  const linked = await database
    .prepare(
      `SELECT user_id FROM external_identities
        WHERE provider = ?1 AND external_subject = ?2`,
    )
    .bind(provider, externalSubject)
    .first<ExternalIdentityRow>();
  return linked?.user_id === linkCode.user_id;
}

export async function listLinkedBotAccounts(
  database: D1Database,
  userId: string,
): Promise<
  { provider: "discord" | "line"; externalSubjectMasked: string; linkedAt: string }[]
> {
  const result = await database
    .prepare(
      `SELECT provider, external_subject, user_id, linked_at
         FROM external_identities
        WHERE user_id = ?1 AND provider IN ('discord', 'line')
        ORDER BY provider`,
    )
    .bind(userId)
    .all<LinkedIdentityRow>();
  return result.results.map((row) => ({
    provider: row.provider,
    externalSubjectMasked: maskExternalSubject(row.external_subject),
    linkedAt: row.linked_at,
  }));
}

export async function unlinkBotAccount(
  database: D1Database,
  userId: string,
  provider: "discord" | "line",
): Promise<boolean> {
  const existing = await database
    .prepare(
      `SELECT provider, external_subject, user_id, linked_at
         FROM external_identities
        WHERE user_id = ?1 AND provider = ?2`,
    )
    .bind(userId, provider)
    .first<LinkedIdentityRow>();
  if (existing === null) return false;
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `DELETE FROM external_identities WHERE user_id = ?1 AND provider = ?2`,
      )
      .bind(userId, provider),
    database
      .prepare(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?1, ?2, 'bot_identity.unlinked', 'user', ?2, ?3, ?4)`,
      )
      .bind(createUuidV7(), userId, JSON.stringify({ provider }), now),
  ]);
  return true;
}

export async function resolveExternalUser(
  environment: Pick<McpRuntimeEnv, "DB">,
  provider: "discord" | "line",
  externalSubject: string,
): Promise<string | null> {
  const value = await environment.DB.prepare(
    `SELECT identities.user_id
       FROM external_identities AS identities
       JOIN users ON users.id = identities.user_id
      WHERE identities.provider = ?1
        AND identities.external_subject = ?2
        AND users.status = 'active'`,
  )
    .bind(provider, externalSubject)
    .first<ExternalIdentityRow>();
  return value?.user_id ?? null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function maskExternalSubject(value: string): string {
  const visible = value.slice(-4);
  const hiddenLength = Math.min(8, Math.max(4, value.length - visible.length));
  return `${"•".repeat(hiddenLength)}${visible}`;
}
