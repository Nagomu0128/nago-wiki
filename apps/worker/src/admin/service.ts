import type {
  AdminMember,
  AuthenticatedIdentity,
  BotChannel,
  BotProvider,
  BotSettingsResponse,
  CreateBotChannelRequest,
  PageAclResponse,
  ReplacePageAclRequest,
  UpdateAdminMemberRequest,
  UpdateBotChannelRequest,
} from "@nago-wiki/shared";

import { AuthorizationService } from "../core/authorization";
import { ApiProblem, isD1UniqueConstraintError } from "../core/errors";
import { D1WikiRepository, pageNotFound } from "../core/repository";
import { createAuditEventStatement as auditEventStatement } from "../core/audit-events";
import { createUuidV7 } from "../core/ids";

interface MemberRow extends Record<string, unknown> {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "suspended";
  linked_bot_providers: string;
  created_at: string;
  updated_at: string;
}

interface AclSnapshotRow extends Record<string, unknown> {
  revision: number;
  updated_at: string | null;
  user_id: string | null;
  display_name: string | null;
  email: string | null;
  permission: "editor" | "viewer" | null;
}

interface AclMemberRow extends Record<string, unknown> {
  id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "suspended";
}

interface BotSettingRow extends Record<string, unknown> {
  provider: BotProvider;
  enabled: number;
}

interface BotChannelRow extends Record<string, unknown> {
  provider: BotProvider;
  external_channel_id: string;
  display_name: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class AdminService {
  readonly #repository: D1WikiRepository;
  readonly #authorization: AuthorizationService;

  public constructor(private readonly database: D1Database) {
    this.#repository = new D1WikiRepository(database);
    this.#authorization = new AuthorizationService(this.#repository);
  }

  public async listMembers(identity: AuthenticatedIdentity): Promise<AdminMember[]> {
    requireOwner(identity);
    const result = await this.database
      .prepare(
        `SELECT users.id, users.email, users.display_name, users.role, users.status,
                users.created_at, users.updated_at,
                coalesce(group_concat(DISTINCT CASE
                  WHEN identities.provider IN ('discord', 'line')
                    THEN identities.provider
                  ELSE NULL
                END), '') AS linked_bot_providers
           FROM users
           LEFT JOIN external_identities AS identities
             ON identities.user_id = users.id
          WHERE users.workspace_id = ?1
          GROUP BY users.id
          ORDER BY users.display_name COLLATE NOCASE, users.id`,
      )
      .bind(identity.workspaceId)
      .all<MemberRow>();
    return result.results.map(mapMember);
  }

  public async updateMember(
    identity: AuthenticatedIdentity,
    memberId: string,
    request: UpdateAdminMemberRequest,
  ): Promise<AdminMember> {
    requireOwner(identity);
    const current = await this.findMember(identity.workspaceId, memberId);
    if (current === null) throw memberNotFound();
    const nextRole = request.role ?? current.role;
    const nextStatus = request.status ?? current.status;
    const updatedAt = monotonicTimestamp(current.updated_at);
    const metadata = {
      before: { role: current.role, status: current.status },
      after: { role: nextRole, status: nextStatus },
    };
    const results = await this.database.batch<MemberRow>([
      this.database
        .prepare(
          `UPDATE users
              SET role = ?1, status = ?2, updated_at = ?3
            WHERE id = ?4 AND workspace_id = ?5 AND updated_at = ?6
              AND (
                role <> 'owner' OR status <> 'active'
                OR (?1 = 'owner' AND ?2 = 'active')
                OR EXISTS (
                  SELECT 1 FROM users AS other
                   WHERE other.workspace_id = ?5 AND other.id <> ?4
                     AND other.role = 'owner' AND other.status = 'active'
                )
              )
          RETURNING id, email, display_name, role, status, '' AS linked_bot_providers,
                    created_at, updated_at`,
        )
        .bind(
          nextRole,
          nextStatus,
          updatedAt,
          memberId,
          identity.workspaceId,
          request.expectedUpdatedAt,
        ),
      this.database
        .prepare(
          `INSERT INTO audit_events
             (id, actor_id, action, target_type, target_id, metadata_json, created_at)
           SELECT ?1, ?2, 'member.updated', 'user', ?3, ?4, ?5
             FROM users
            WHERE id = ?3 AND workspace_id = ?6 AND updated_at = ?5`,
        )
        .bind(
          createUuidV7(),
          identity.id,
          memberId,
          JSON.stringify(metadata),
          updatedAt,
          identity.workspaceId,
        ),
    ]);
    const updated = results[0]?.results[0];
    if (updated !== undefined) {
      const member = await this.findMember(identity.workspaceId, memberId);
      if (member !== null) return mapMember(member);
    }

    const latest = await this.findMember(identity.workspaceId, memberId);
    if (latest === null) throw memberNotFound();
    if (latest.updated_at !== request.expectedUpdatedAt) {
      throw new ApiProblem(
        "MEMBER_UPDATE_CONFLICT",
        409,
        "The member changed after it was loaded",
        { updatedAt: latest.updated_at },
      );
    }
    throw new ApiProblem(
      "LAST_ACTIVE_OWNER",
      409,
      "The workspace must keep at least one active owner",
    );
  }

  public async getPageAcl(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PageAclResponse> {
    await this.requireRestrictedPageOwner(identity, pageId);
    const snapshot = await this.database
      .prepare(
        `SELECT coalesce(revisions.revision, 0) AS revision, revisions.updated_at,
                acl.user_id, users.display_name, users.email, acl.permission
           FROM (SELECT ?1 AS page_id) AS target
           LEFT JOIN page_acl_revisions AS revisions ON revisions.page_id = target.page_id
           LEFT JOIN page_acl AS acl ON acl.page_id = target.page_id
           LEFT JOIN users ON users.id = acl.user_id AND users.workspace_id = ?2
          ORDER BY users.display_name COLLATE NOCASE, users.id`,
      )
      .bind(pageId, identity.workspaceId)
      .all<AclSnapshotRow>();
    const revision = snapshot.results[0];
    return {
      pageId,
      revision: revision?.revision ?? 0,
      updatedAt: revision?.updated_at ?? null,
      entries: snapshot.results.flatMap((entry) => entry.user_id === null ||
        entry.display_name === null || entry.email === null || entry.permission === null
        ? []
        : [{
        userId: entry.user_id,
        displayName: entry.display_name,
        email: entry.email,
        permission: entry.permission,
      }]),
    };
  }

  public async replacePageAcl(
    identity: AuthenticatedIdentity,
    pageId: string,
    request: ReplacePageAclRequest,
  ): Promise<PageAclResponse> {
    const page = await this.requireRestrictedPageOwner(identity, pageId);
    await this.validateAclMembers(identity.workspaceId, pageId, request);
    const now = new Date().toISOString();
    const mutationId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO page_acl_revisions
             (page_id, revision, last_mutation_id, updated_by, updated_at)
           VALUES (?1, 0, NULL, NULL, ?2)`,
        )
        .bind(pageId, page.createdAt),
      this.database
        .prepare(
          `UPDATE page_acl_revisions
              SET revision = revision + 1, last_mutation_id = ?1,
                  updated_by = ?2, updated_at = ?3
            WHERE page_id = ?4 AND revision = ?5
          RETURNING revision`,
        )
        .bind(mutationId, identity.id, now, pageId, request.baseRevision),
      this.database
        .prepare(
          `DELETE FROM page_acl
            WHERE page_id = ?1
              AND EXISTS (
                SELECT 1 FROM page_acl_revisions
                 WHERE page_id = ?1 AND last_mutation_id = ?2
              )`,
        )
        .bind(pageId, mutationId),
    ];
    for (const entry of request.entries) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO page_acl
               (page_id, user_id, permission, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?4
              WHERE EXISTS (
                SELECT 1 FROM page_acl_revisions
                 WHERE page_id = ?1 AND last_mutation_id = ?5
              )`,
          )
          .bind(pageId, entry.userId, entry.permission, now, mutationId),
      );
    }
    statements.push(
      this.database
        .prepare(
          `INSERT INTO audit_events
             (id, actor_id, action, target_type, target_id, metadata_json, created_at)
           SELECT ?1, ?2, 'page_acl.replaced', 'page', ?3, ?4, ?5
             FROM page_acl_revisions
            WHERE page_id = ?3 AND last_mutation_id = ?6`,
        )
        .bind(
          createUuidV7(),
          identity.id,
          pageId,
          JSON.stringify({
            revision: request.baseRevision + 1,
            entries: request.entries,
          }),
          now,
          mutationId,
        ),
    );
    const results = await this.database.batch(statements);
    if (results[1]?.meta.changes !== 1) {
      const current = await this.getPageAcl(identity, pageId);
      throw new ApiProblem(
        "ACL_REVISION_CONFLICT",
        409,
        "The page access list changed after it was loaded",
        { revision: current.revision },
      );
    }
    return this.getPageAcl(identity, pageId);
  }

  public async getBotSettings(
    identity: AuthenticatedIdentity,
  ): Promise<BotSettingsResponse> {
    requireOwner(identity);
    const [settings, channels] = await Promise.all([
      this.database
        .prepare(
          `SELECT provider, enabled FROM workspace_bot_settings
            WHERE workspace_id = ?1`,
        )
        .bind(identity.workspaceId)
        .all<BotSettingRow>(),
      this.database
        .prepare(
          `SELECT provider, external_channel_id, display_name, enabled,
                  created_at, updated_at
             FROM bot_channel_allowlist
            WHERE workspace_id = ?1
            ORDER BY provider, coalesce(display_name, external_channel_id) COLLATE NOCASE`,
        )
        .bind(identity.workspaceId)
        .all<BotChannelRow>(),
    ]);
    const settingsByProvider = new Map(
      settings.results.map((setting) => [setting.provider, setting.enabled === 1]),
    );
    return {
      providers: (["discord", "line"] as const).map((provider) => ({
        provider,
        enabled: settingsByProvider.get(provider) ?? true,
        channels: channels.results
          .filter((channel) => channel.provider === provider)
          .map(mapBotChannel),
      })),
    };
  }

  public async setBotProviderEnabled(
    identity: AuthenticatedIdentity,
    provider: BotProvider,
    enabled: boolean,
  ): Promise<BotSettingsResponse> {
    requireOwner(identity);
    const before = await this.getBotSettings(identity);
    const previous = before.providers.find((entry) => entry.provider === provider)?.enabled ?? true;
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO workspace_bot_settings
             (workspace_id, provider, enabled, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, provider) DO UPDATE SET
             enabled = excluded.enabled,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(identity.workspaceId, provider, enabled ? 1 : 0, identity.id, now),
      auditEventStatement(this.database, {
        actorId: identity.id,
        action: "bot_provider.updated",
        targetType: "bot_provider",
        targetId: provider,
        metadata: { before: { enabled: previous }, after: { enabled } },
        createdAt: now,
      }),
    ]);
    return this.getBotSettings(identity);
  }

  public async createBotChannel(
    identity: AuthenticatedIdentity,
    request: CreateBotChannelRequest,
  ): Promise<BotChannel> {
    requireOwner(identity);
    const now = new Date().toISOString();
    try {
      await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO bot_channel_allowlist
               (workspace_id, provider, external_channel_id, display_name, enabled,
                created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
          )
          .bind(
            identity.workspaceId,
            request.provider,
            request.externalChannelId,
            request.displayName,
            request.enabled ? 1 : 0,
            identity.id,
            now,
          ),
        auditEventStatement(this.database, {
          actorId: identity.id,
          action: "bot_channel.created",
          targetType: "bot_channel",
          targetId: channelTarget(request.provider, request.externalChannelId),
          metadata: {
            provider: request.provider,
            displayName: request.displayName,
            enabled: request.enabled,
          },
          createdAt: now,
        }),
      ]);
    } catch (error) {
      if (isD1UniqueConstraintError(error)) {
        throw new ApiProblem("INVALID_REQUEST", 409, "This channel is already configured");
      }
      throw error;
    }
    const channel = await this.findBotChannel(
      identity.workspaceId,
      request.provider,
      request.externalChannelId,
    );
    if (channel === null) throw new ApiProblem("INTERNAL_ERROR", 500, "The channel was not created");
    return mapBotChannel(channel);
  }

  public async updateBotChannel(
    identity: AuthenticatedIdentity,
    provider: BotProvider,
    externalChannelId: string,
    request: UpdateBotChannelRequest,
  ): Promise<BotChannel> {
    requireOwner(identity);
    const current = await this.findBotChannel(identity.workspaceId, provider, externalChannelId);
    if (current === null) throw botChannelNotFound();
    const displayName = request.displayName === undefined
      ? current.display_name
      : request.displayName;
    const enabled = request.enabled ?? current.enabled === 1;
    const now = monotonicTimestamp(current.updated_at);
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO audit_events
             (id, actor_id, action, target_type, target_id, metadata_json, created_at)
           SELECT ?1, ?2, 'bot_channel.updated', 'bot_channel', ?3, ?4, ?5
             FROM bot_channel_allowlist
            WHERE workspace_id = ?6 AND provider = ?7 AND external_channel_id = ?8
              AND updated_at = ?9`,
        )
        .bind(
          createUuidV7(),
          identity.id,
          channelTarget(provider, externalChannelId),
          JSON.stringify({
            before: { displayName: current.display_name, enabled: current.enabled === 1 },
            after: { displayName, enabled },
          }),
          now,
          identity.workspaceId,
          provider,
          externalChannelId,
          current.updated_at,
        ),
      this.database
        .prepare(
          `UPDATE bot_channel_allowlist
              SET display_name = ?1, enabled = ?2, updated_at = ?3
            WHERE workspace_id = ?4 AND provider = ?5 AND external_channel_id = ?6
              AND updated_at = ?7`,
        )
        .bind(
          displayName,
          enabled ? 1 : 0,
          now,
          identity.workspaceId,
          provider,
          externalChannelId,
          current.updated_at,
        ),
    ]);
    if (results[1]?.meta.changes !== 1) throw botChannelConflict();
    const updated = await this.findBotChannel(identity.workspaceId, provider, externalChannelId);
    if (updated === null) throw botChannelNotFound();
    return mapBotChannel(updated);
  }

  public async deleteBotChannel(
    identity: AuthenticatedIdentity,
    provider: BotProvider,
    externalChannelId: string,
  ): Promise<void> {
    requireOwner(identity);
    const current = await this.findBotChannel(identity.workspaceId, provider, externalChannelId);
    if (current === null) throw botChannelNotFound();
    const now = new Date().toISOString();
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO audit_events
             (id, actor_id, action, target_type, target_id, metadata_json, created_at)
           SELECT ?1, ?2, 'bot_channel.deleted', 'bot_channel', ?3, ?4, ?5
             FROM bot_channel_allowlist
            WHERE workspace_id = ?6 AND provider = ?7 AND external_channel_id = ?8
              AND updated_at = ?9`,
        )
        .bind(
          createUuidV7(),
          identity.id,
          channelTarget(provider, externalChannelId),
          JSON.stringify({
            provider,
            displayName: current.display_name,
            enabled: current.enabled === 1,
          }),
          now,
          identity.workspaceId,
          provider,
          externalChannelId,
          current.updated_at,
        ),
      this.database
        .prepare(
          `DELETE FROM bot_channel_allowlist
            WHERE workspace_id = ?1 AND provider = ?2 AND external_channel_id = ?3
              AND updated_at = ?4`,
        )
        .bind(identity.workspaceId, provider, externalChannelId, current.updated_at),
    ]);
    if (results[1]?.meta.changes !== 1) throw botChannelNotFound();
  }

  private async findMember(workspaceId: string, memberId: string): Promise<MemberRow | null> {
    return this.database
      .prepare(
        `SELECT users.id, users.email, users.display_name, users.role, users.status,
                users.created_at, users.updated_at,
                coalesce(group_concat(DISTINCT CASE
                  WHEN identities.provider IN ('discord', 'line')
                    THEN identities.provider
                  ELSE NULL
                END), '') AS linked_bot_providers
           FROM users
           LEFT JOIN external_identities AS identities ON identities.user_id = users.id
          WHERE users.workspace_id = ?1 AND users.id = ?2
          GROUP BY users.id`,
      )
      .bind(workspaceId, memberId)
      .first<MemberRow>();
  }

  private async requireRestrictedPageOwner(
    identity: AuthenticatedIdentity,
    pageId: string,
  ) {
    const [page, permission] = await Promise.all([
      this.#repository.getPage(pageId),
      this.#authorization.effectivePermission(identity, pageId),
    ]);
    if (page?.workspaceId !== identity.workspaceId || permission !== "owner") {
      throw pageNotFound();
    }
    if (page.status !== "active") {
      throw pageNotFound();
    }
    if (page.accessMode !== "restricted") {
      throw new ApiProblem(
        "PAGE_NOT_RESTRICTED",
        409,
        "Access lists are available only for restricted pages",
      );
    }
    return page;
  }

  private async validateAclMembers(
    workspaceId: string,
    pageId: string,
    request: ReplacePageAclRequest,
  ): Promise<void> {
    if (request.entries.length === 0) return;
    const result = await this.database
      .prepare(
        `SELECT id, role, status FROM users
          WHERE workspace_id = ?1
            AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(workspaceId, JSON.stringify(request.entries.map((entry) => entry.userId)))
      .all<AclMemberRow>();
    const members = new Map(result.results.map((member) => [member.id, member]));
    const invalid = request.entries.some((entry) => {
      const member = members.get(entry.userId);
      return (
        member?.status !== "active" ||
        member.role === "owner" ||
        (entry.permission === "editor" && member.role !== "editor")
      );
    });
    if (invalid) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        400,
        "ACL entries must reference active members without exceeding their workspace role",
      );
    }
    await this.validateInheritedAclBoundary(workspaceId, pageId, request.entries);
  }

  private async validateInheritedAclBoundary(
    workspaceId: string,
    pageId: string,
    entries: ReplacePageAclRequest["entries"],
  ): Promise<void> {
    if (entries.length === 0) return;
    const ancestors = await this.database
      .prepare(
        `WITH RECURSIVE ancestors(id, parent_id, access_mode) AS (
           SELECT id, parent_id, access_mode
             FROM pages
            WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.access_mode
             FROM pages AS parent
             JOIN ancestors ON ancestors.parent_id = parent.id
            WHERE parent.workspace_id = ?2 AND parent.status = 'active'
         )
         SELECT id FROM ancestors WHERE id <> ?1 AND access_mode = 'restricted'`,
      )
      .bind(pageId, workspaceId)
      .all<{ id: string }>();
    if (ancestors.results.length === 0) return;

    const ancestorIds = ancestors.results.map((ancestor) => ancestor.id);
    const grants = await this.database
      .prepare(
        `SELECT page_id, user_id FROM page_acl
          WHERE page_id IN (SELECT value FROM json_each(?1))
            AND user_id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(
        JSON.stringify(ancestorIds),
        JSON.stringify(entries.map((entry) => entry.userId)),
      )
      .all<{ page_id: string; user_id: string }>();
    const grantsByUser = new Map<string, Set<string>>();
    for (const grant of grants.results) {
      const userGrants = grantsByUser.get(grant.user_id) ?? new Set<string>();
      userGrants.add(grant.page_id);
      grantsByUser.set(grant.user_id, userGrants);
    }
    if (entries.some((entry) => grantsByUser.get(entry.userId)?.size !== ancestorIds.length)) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        400,
        "ACL entries cannot grant access beyond a restricted ancestor",
      );
    }
  }

  private async findBotChannel(
    workspaceId: string,
    provider: BotProvider,
    externalChannelId: string,
  ): Promise<BotChannelRow | null> {
    return this.database
      .prepare(
        `SELECT provider, external_channel_id, display_name, enabled, created_at, updated_at
           FROM bot_channel_allowlist
          WHERE workspace_id = ?1 AND provider = ?2 AND external_channel_id = ?3`,
      )
      .bind(workspaceId, provider, externalChannelId)
      .first<BotChannelRow>();
  }
}

function requireOwner(identity: AuthenticatedIdentity): void {
  if (identity.role !== "owner" || identity.status !== "active") {
    throw new ApiProblem("FORBIDDEN", 403, "Workspace owner access is required");
  }
}

function mapMember(row: MemberRow): AdminMember {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    linkedBotProviders: row.linked_bot_providers.length === 0
      ? []
      : row.linked_bot_providers.split(",").filter(isBotProvider),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBotChannel(row: BotChannelRow): BotChannel {
  return {
    provider: row.provider,
    externalChannelId: row.external_channel_id,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isBotProvider(value: string): value is BotProvider {
  return value === "discord" || value === "line";
}

function memberNotFound(): ApiProblem {
  return new ApiProblem("MEMBER_NOT_FOUND", 404, "The member was not found");
}

function botChannelNotFound(): ApiProblem {
  return new ApiProblem("BOT_CHANNEL_NOT_FOUND", 404, "The bot channel was not found");
}

function botChannelConflict(): ApiProblem {
  return new ApiProblem(
    "BOT_CHANNEL_UPDATE_CONFLICT",
    409,
    "The bot channel changed after it was loaded",
  );
}

function channelTarget(provider: BotProvider, externalChannelId: string): string {
  return `${provider}:${externalChannelId}`;
}

function monotonicTimestamp(previous: string): string {
  const current = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Number.isNaN(previousTime) ? current : Math.max(current, previousTime + 1)).toISOString();
}
