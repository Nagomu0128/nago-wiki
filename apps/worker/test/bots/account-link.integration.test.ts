import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  consumeAccountLinkCode,
  issueAccountLinkCode,
} from "../../src/bots/account-link";
import { createUuidV7 } from "../../src/core/ids";
import { DEFAULT_WORKSPACE_ID } from "../../src/core/repository";

describe("bot account link audit", () => {
  let userId: string;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM account_link_codes"),
      env.DB.prepare(
        "DELETE FROM external_identities WHERE provider IN ('discord', 'line')",
      ),
      env.DB.prepare(
        "DELETE FROM audit_events WHERE action = 'bot_identity.linked'",
      ),
      env.DB.prepare("DELETE FROM users WHERE email = 'bot-link@example.com'"),
    ]);
    userId = createUuidV7();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users
         (id, workspace_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'bot-link@example.com', 'Bot Link', 'viewer', 'active', ?3, ?3)`,
    )
      .bind(userId, DEFAULT_WORKSPACE_ID, now)
      .run();
  });

  it("records one privacy-safe event in the successful link mutation batch", async () => {
    const issued = await issueAccountLinkCode(env.DB, userId, "discord");
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "sensitive-discord-subject-1234",
        issued.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(true);
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "sensitive-discord-subject-1234",
        issued.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(false);

    const events = await env.DB.prepare(
      `SELECT actor_id, action, target_type, target_id, metadata_json
         FROM audit_events
        WHERE action = 'bot_identity.linked'`,
    ).all<{
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      metadata_json: string;
    }>();
    expect(events.results).toEqual([
      {
        actor_id: userId,
        action: "bot_identity.linked",
        target_type: "user",
        target_id: userId,
        metadata_json: JSON.stringify({ provider: "discord" }),
      },
    ]);
    expect(JSON.stringify(events.results)).not.toContain(
      "sensitive-discord-subject-1234",
    );
  });

  it("does not audit a failed link or an existing identity no-op", async () => {
    const wrongProvider = await issueAccountLinkCode(env.DB, userId, "line");
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-subject",
        wrongProvider.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(false);

    const first = await issueAccountLinkCode(env.DB, userId, "discord");
    const second = await issueAccountLinkCode(env.DB, userId, "discord");
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-subject",
        first.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(true);
    await expect(
      consumeAccountLinkCode(
        env.DB,
        "discord",
        "discord-subject",
        second.code,
        DEFAULT_WORKSPACE_ID,
      ),
    ).resolves.toBe(true);

    const count = await env.DB.prepare(
      `SELECT count(*) AS count
         FROM audit_events
        WHERE action = 'bot_identity.linked'`,
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
