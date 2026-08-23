import { useMemo, useState } from "react";

import {
  useApiMutation,
  useApiQuery,
  type AdminMember,
  type BotProvider,
  type BotProviderSettings,
  type PageAclPermission,
  type PageAclResponse,
  type SessionUser,
  type WikiApi,
  type PageResource,
  type WorkspaceRole,
} from "../api";
import { AccountLinkDrawer } from "./AccountLinkDrawer";

interface SettingsDrawerProps {
  api: WikiApi;
  currentPage?: PageResource | undefined;
  user?: SessionUser | undefined;
}

const providerNames: Record<BotProvider, string> = {
  discord: "Discord",
  line: "LINE",
};

export function SettingsDrawer({ api, currentPage, user }: SettingsDrawerProps) {
  const isOwner = user?.role === "owner";
  const accounts = useApiQuery((signal) => api.getLinkedBotAccounts(signal), [api]);
  const members = useApiQuery((signal) => api.getAdminMembers(signal), [api], isOwner);
  const bots = useApiQuery((signal) => api.getBotSettings(signal), [api], isOwner);
  const unlink = useApiMutation((provider: BotProvider, signal) => api.unlinkBotAccount(provider, signal));

  const unlinkAccount = async (provider: BotProvider) => {
    await unlink.mutate(provider);
    accounts.refetch();
  };

  return (
    <div className="settings-panel">
      <div className="drawer-section-title">
        <span>Workspace settings</span>
        <h2>設定</h2>
        <p>アカウント連携と、Wikiのアクセス・Bot利用範囲を管理します。</p>
      </div>

      <section aria-labelledby="connected-accounts-heading" className="settings-section">
        <h3 id="connected-accounts-heading">自分のBot連携</h3>
        {accounts.status === "loading" && <p className="settings-muted">連携状態を読み込み中…</p>}
        {accounts.status === "error" && <SettingsError error={accounts.error} />}
        {accounts.status === "success" && accounts.data.length > 0 && (
          <ul className="settings-list linked-account-list">
            {accounts.data.map((account) => (
              <li key={`${account.provider}:${account.externalSubjectMasked}`}>
                <span><strong>{providerNames[account.provider]}</strong><small>{account.externalSubjectMasked}</small></span>
                <button
                  disabled={unlink.status === "loading"}
                  onClick={() => { void unlinkAccount(account.provider).catch(() => undefined); }}
                  type="button"
                >
                  解除
                </button>
              </li>
            ))}
          </ul>
        )}
        <AccountLinkDrawer api={api} compact />
      </section>

      {!isOwner && (
        <p className="settings-owner-note">メンバー、ページACL、BotチャンネルはOwnerが管理できます。</p>
      )}

      {isOwner && (
        <>
          <section aria-labelledby="members-heading" className="settings-section">
            <h3 id="members-heading">メンバー</h3>
            {members.status === "loading" && <p className="settings-muted">メンバーを読み込み中…</p>}
            {members.status === "error" && <SettingsError error={members.error} />}
            {members.status === "success" && (
              <ul className="settings-list member-list">
                {members.data.map((member) => (
                  <MemberControl api={api} key={member.id} member={member} onSaved={members.refetch} />
                ))}
              </ul>
            )}
          </section>

          <PageAclControl
            api={api}
            members={members.status === "success" ? members.data : []}
            page={currentPage}
          />

          <section aria-labelledby="bots-heading" className="settings-section">
            <h3 id="bots-heading">Discord / LINE Bot</h3>
            {bots.status === "loading" && <p className="settings-muted">Bot設定を読み込み中…</p>}
            {bots.status === "error" && <SettingsError error={bots.error} />}
            {bots.status === "success" && (
              <BotControls api={api} onChanged={bots.refetch} providers={bots.data} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function MemberControl({
  api,
  member,
  onSaved,
}: {
  api: WikiApi;
  member: AdminMember;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [status, setStatus] = useState(member.status);
  const save = useApiMutation((_: undefined, signal) =>
    api.updateAdminMember(
      member.id,
      { role, status, expectedUpdatedAt: member.updatedAt },
      signal,
    ),
  );
  const submit = async () => {
    await save.mutate(undefined);
    onSaved();
  };
  return (
    <li>
      <span className="member-summary">
        <strong>{member.displayName}</strong>
        <small>{member.email}</small>
      </span>
      <label>
        <span className="sr-only">{member.displayName}のロール</span>
        <select aria-label={`${member.displayName}のロール`} onChange={(event) => { setRole(event.target.value as WorkspaceRole); }} value={role}>
          <option value="owner">Owner</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
      </label>
      <label>
        <span className="sr-only">{member.displayName}の状態</span>
        <select aria-label={`${member.displayName}の状態`} onChange={(event) => { setStatus(event.target.value as AdminMember["status"]); }} value={status}>
          <option value="active">有効</option>
          <option value="suspended">停止</option>
        </select>
      </label>
      <button disabled={save.status === "loading"} onClick={() => { void submit().catch(() => undefined); }} type="button">保存</button>
      {save.status === "error" && <SettingsError error={save.error} />}
    </li>
  );
}

function PageAclControl({ api, members, page }: { api: WikiApi; members: AdminMember[]; page?: PageResource | undefined }) {
  const enabled = page?.page.accessMode === "restricted";
  const pageId = page?.page.id ?? "";
  const acl = useApiQuery((signal) => api.getPageAcl(pageId, signal), [api, pageId], enabled);
  const eligibleMembers = useMemo(
    () => members.filter((member) => member.role !== "owner" && member.status === "active"),
    [members],
  );
  const aclReady = enabled && acl.status === "success" && acl.data.pageId === pageId;

  return (
    <section aria-labelledby="acl-heading" className="settings-section">
      <h3 id="acl-heading">選択中ページのアクセス</h3>
      {!page && <p className="settings-muted">ページを選択してください。</p>}
      {page && !enabled && <p className="settings-muted">このページはWorkspace公開です。ACLはrestrictedページで設定できます。</p>}
      {enabled && !aclReady && acl.status !== "error" && <p className="settings-muted">ACLを読み込み中…</p>}
      {enabled && acl.status === "error" && <SettingsError error={acl.error} />}
      {aclReady && (
        <AclEditor
          acl={acl.data}
          api={api}
          key={`${acl.data.pageId}:${String(acl.data.revision)}`}
          members={eligibleMembers}
          onSaved={acl.refetch}
          pageTitle={page.page.title}
        />
      )}
    </section>
  );
}

function AclEditor({
  acl,
  api,
  members,
  onSaved,
  pageTitle,
}: {
  acl: PageAclResponse;
  api: WikiApi;
  members: AdminMember[];
  onSaved: () => void;
  pageTitle: string;
}) {
  const [selection, setSelection] = useState<Record<string, PageAclPermission | "none">>(
    Object.fromEntries(acl.entries.map((entry) => [entry.userId, entry.permission])),
  );
  const save = useApiMutation((_: undefined, signal) =>
    api.replacePageAcl(
      acl.pageId,
      {
        baseRevision: acl.revision,
        entries: Object.entries(selection)
          .filter((entry): entry is [string, PageAclPermission] => entry[1] !== "none")
          .map(([userId, permission]) => ({ userId, permission })),
      },
      signal,
    ),
  );
  const saveAcl = async () => {
    await save.mutate(undefined);
    onSaved();
  };
  return (
    <fieldset className="acl-members">
      <legend>{pageTitle}へアクセスできるメンバー</legend>
      {members.map((member) => (
        <label key={member.id}>
          <span><strong>{member.displayName}</strong><small>{member.email}</small></span>
          <select
            aria-label={`${member.displayName}のページ権限`}
            onChange={(event) => {
              setSelection((current) => ({
                ...current,
                [member.id]: event.target.value as PageAclPermission | "none",
              }));
            }}
            value={selection[member.id] ?? "none"}
          >
            <option value="none">アクセスなし</option>
            <option value="viewer">閲覧</option>
            {member.role === "editor" && <option value="editor">編集</option>}
          </select>
        </label>
      ))}
      <button className="button button-primary settings-save" disabled={save.status === "loading"} onClick={() => { void saveAcl().catch(() => undefined); }} type="button">ACLを保存</button>
      {save.status === "error" && <SettingsError error={save.error} />}
    </fieldset>
  );
}

function BotControls({
  api,
  onChanged,
  providers,
}: {
  api: WikiApi;
  onChanged: () => void;
  providers: BotProviderSettings[];
}) {
  const [provider, setProvider] = useState<BotProvider>("discord");
  const [channelId, setChannelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const providerUpdate = useApiMutation(
    (input: { provider: BotProvider; enabled: boolean }, signal) =>
      api.setBotProviderEnabled(input.provider, input.enabled, signal),
  );
  const channelCreate = useApiMutation((_: undefined, signal) =>
    api.createBotChannel(
      { provider, externalChannelId: channelId, displayName: displayName.trim() || null, enabled: true },
      signal,
    ),
  );
  const channelUpdate = useApiMutation(
    (input: { provider: BotProvider; id: string; enabled: boolean }, signal) =>
      api.updateBotChannel(input.provider, input.id, { enabled: input.enabled }, signal),
  );
  const channelDelete = useApiMutation(
    (input: { provider: BotProvider; id: string }, signal) =>
      api.deleteBotChannel(input.provider, input.id, signal),
  );

  const mutateAndRefresh = async (operation: Promise<unknown>) => {
    await operation;
    onChanged();
  };
  const create = async () => {
    await channelCreate.mutate(undefined);
    setChannelId("");
    setDisplayName("");
    onChanged();
  };

  return (
    <div className="bot-settings">
      {providers.map((setting) => (
        <div className="bot-provider" key={setting.provider}>
          <div>
            <strong>{providerNames[setting.provider]}</strong>
            <button
              aria-pressed={setting.enabled}
              disabled={providerUpdate.status === "loading"}
              onClick={() => { void mutateAndRefresh(providerUpdate.mutate({ provider: setting.provider, enabled: !setting.enabled })).catch(() => undefined); }}
              type="button"
            >
              {setting.enabled ? "有効" : "停止中"}
            </button>
          </div>
          <ul className="settings-list channel-list">
            {setting.channels.map((channel) => (
              <li key={channel.externalChannelId}>
                <span><strong>{channel.displayName ?? channel.externalChannelId}</strong><small>{channel.externalChannelId}</small></span>
                <button
                  aria-label={`${channel.displayName ?? channel.externalChannelId}を${channel.enabled ? "停止" : "有効化"}`}
                  onClick={() => { void mutateAndRefresh(channelUpdate.mutate({ provider: setting.provider, id: channel.externalChannelId, enabled: !channel.enabled })).catch(() => undefined); }}
                  type="button"
                >
                  {channel.enabled ? "停止" : "有効化"}
                </button>
                <button
                  aria-label={`${channel.displayName ?? channel.externalChannelId}を削除`}
                  onClick={() => { void mutateAndRefresh(channelDelete.mutate({ provider: setting.provider, id: channel.externalChannelId })).catch(() => undefined); }}
                  type="button"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <fieldset className="channel-create">
        <legend>許可チャンネルを追加</legend>
        <label>サービス<select onChange={(event) => { setProvider(event.target.value as BotProvider); }} value={provider}><option value="discord">Discord</option><option value="line">LINE</option></select></label>
        <label>チャンネルID<input maxLength={256} onChange={(event) => { setChannelId(event.target.value); }} value={channelId} /></label>
        <label>表示名（任意）<input maxLength={200} onChange={(event) => { setDisplayName(event.target.value); }} value={displayName} /></label>
        <button className="button button-primary" disabled={!channelId.trim() || channelCreate.status === "loading"} onClick={() => { void create().catch(() => undefined); }} type="button">追加</button>
      </fieldset>
      {providerUpdate.status === "error" && <SettingsError error={providerUpdate.error} />}
      {channelCreate.status === "error" && <SettingsError error={channelCreate.error} />}
      {channelUpdate.status === "error" && <SettingsError error={channelUpdate.error} />}
      {channelDelete.status === "error" && <SettingsError error={channelDelete.error} />}
    </div>
  );
}

function SettingsError({ error }: { error: Error }) {
  return <p className="drawer-error" role="alert">{error.message}</p>;
}
