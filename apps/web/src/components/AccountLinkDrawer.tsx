import { useState } from "react";
import { useApiMutation, type BotProvider, type WikiApi } from "../api";

interface AccountLinkDrawerProps {
  api: WikiApi;
  compact?: boolean;
}

const providerNames: Record<BotProvider, string> = {
  discord: "Discord",
  line: "LINE",
};

function formatExpiry(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeStyle: "short" }).format(new Date(value));
}

export function AccountLinkDrawer({ api, compact = false }: AccountLinkDrawerProps) {
  const [provider, setProvider] = useState<BotProvider>("discord");
  const [copied, setCopied] = useState(false);
  const link = useApiMutation((selected: BotProvider, signal) => api.createAccountLink(selected, signal));

  const issue = async () => {
    setCopied(false);
    await link.mutate(provider);
  };

  const copyCommand = async () => {
    if (link.status !== "success") return;
    await navigator.clipboard.writeText(`link ${link.data.code}`);
    setCopied(true);
  };

  return (
    <div className={compact ? "account-link-compact" : "account-link-panel"}>
      {!compact && <div className="drawer-section-title">
        <span>Connected assistants</span>
        <h2>Botアカウント連携</h2>
        <p>DiscordまたはLINEからWikiの知識へ、安全に質問できるようにします。</p>
      </div>}

      <fieldset className="account-link-providers">
        <legend>連携先</legend>
        {(["discord", "line"] as const).map((candidate) => (
          <button
            aria-pressed={candidate === provider}
            key={candidate}
            onClick={() => { setProvider(candidate); setCopied(false); }}
            type="button"
          >
            {providerNames[candidate]}
          </button>
        ))}
      </fieldset>

      <button className="button button-primary account-link-issue" disabled={link.status === "loading"} onClick={() => { void issue().catch(() => undefined); }} type="button">
        {link.status === "loading" ? "発行中…" : `${providerNames[provider]}用コードを発行`}
      </button>

      {link.status === "error" && <div className="drawer-error" role="alert">{link.error.message}</div>}
      {link.status === "success" && (
        <section className="account-link-result" aria-live="polite">
          <strong>{formatExpiry(link.data.expiresAt)}まで有効な一度限りのコードです</strong>
          <code>link {link.data.code}</code>
          <button className="button" onClick={() => { void copyCommand().catch(() => undefined); }} type="button">
            {copied ? "コピーしました" : "コマンドをコピー"}
          </button>
          <ol>
            <li>{providerNames[provider]}でNago Wiki BotとのDMを開きます。</li>
            <li>上のコマンドをそのまま送信します。</li>
            <li>連携完了の返信後、DMまたは許可済みチャンネルで質問できます。</li>
          </ol>
        </section>
      )}
      <p className="account-link-note">コードは10分間・1回だけ使用できます。コード自体はサーバーに保存されません。</p>
    </div>
  );
}
