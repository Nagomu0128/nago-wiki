import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  consumeAccountLinkCode,
  issueAccountLinkCode,
  listLinkedBotAccounts,
  unlinkBotAccount,
} from "../../src/bots/account-link";
import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";

const userId = "00000000-0000-7000-8000-000000000030";

describe("bot account links", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM account_link_codes`),
      env.DB.prepare(`DELETE FROM external_identities`),
      env.DB.prepare(`DELETE FROM audit_events`),
      env.DB.prepare(`DELETE FROM users`),
    ]);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'linked@example.com', 'Linked', 'viewer', 'active', ?3, ?3)`,
    )
      .bind(userId, DEFAULT_WORKSPACE_ID, now)
      .run();
  });

  it("audits successful link and unlink changes without exposing the subject", async () => {
    const issued = await issueAccountLinkCode(env.DB, userId, "discord");
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-user-123456",
        issued.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(true);

    const accounts = await listLinkedBotAccounts(env.DB, userId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe("discord");
    expect(accounts[0]?.externalSubjectMasked).not.toContain("discord-user");
    await expect(unlinkBotAccount(env.DB, userId, "discord")).resolves.toBe(true);
    await expect(unlinkBotAccount(env.DB, userId, "discord")).resolves.toBe(false);

    const audit = await env.DB.prepare(
      `SELECT action, metadata_json FROM audit_events WHERE actor_id = ?1 ORDER BY created_at`,
    )
      .bind(userId)
      .all<{ action: string; metadata_json: string }>();
    expect(audit.results.map((event) => event.action)).toEqual([
      "bot_identity.linked",
      "bot_identity.unlinked",
    ]);
    expect(audit.results.map((event) => event.metadata_json).join(" ")).not.toContain(
      "discord-user-123456",
    );
  });

  it("does not link a suspended member or a code in another workspace", async () => {
    const suspended = await issueAccountLinkCode(env.DB, userId, "discord");
    await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?1`)
      .bind(userId)
      .run();
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-user-suspended",
        suspended.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(false);

    await env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?1`)
      .bind(userId)
      .run();
    const crossWorkspace = await issueAccountLinkCode(env.DB, userId, "discord");
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-user-other-workspace",
        crossWorkspace.code,
        "00000000-0000-7000-8000-000000000099",
      ),
    ).resolves.toBe(false);
  });
});
