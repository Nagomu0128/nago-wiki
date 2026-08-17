import type { McpRuntimeEnv } from "../mcp/types";

interface LinkCodeRow {
  id: string;
  user_id: string;
  provider: string | null;
}

interface ExternalIdentityRow {
  user_id: string;
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
): Promise<boolean> {
  const hash = await sha256Hex(code.trim());
  const linkCode = await database
    .prepare(
      `SELECT id, user_id, provider
         FROM account_link_codes
        WHERE code_hash = ?1
          AND consumed_at IS NULL
          AND expires_at > ?2
          AND (provider IS NULL OR provider = ?3)`,
    )
    .bind(hash, new Date().toISOString(), provider)
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
  await database.batch([
    database
      .prepare(
        `UPDATE account_link_codes SET consumed_at = ?2
          WHERE id = ?1 AND consumed_at IS NULL`,
      )
      .bind(linkCode.id, marker),
    database
      .prepare(
        `INSERT OR IGNORE INTO external_identities
           (provider, external_subject, user_id, linked_at)
         SELECT ?1, ?2, user_id, ?3
           FROM account_link_codes
          WHERE id = ?4 AND consumed_at = ?5`,
      )
      .bind(provider, externalSubject, new Date().toISOString(), linkCode.id, marker),
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
