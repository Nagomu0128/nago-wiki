import { useEffect, useMemo, useState } from "react";
import { useApiMutation, type ImportJob, type ImportRequest, type WikiApi } from "../api";
import { diffLines } from "./diff";
import { extractGoogleDocumentId } from "./google-document";

export interface GoogleDocumentPicker {
  pick(): Promise<{ documentId: string; name: string } | null>;
}

interface ImportDrawerProps {
  api: WikiApi;
  parentPageId: string | null;
  picker?: GoogleDocumentPicker;
  onApplied: (pageId: string) => void;
}

export function ImportDrawer({ api, parentPageId, picker, onApplied }: ImportDrawerProps) {
  const [sourceValue, setSourceValue] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [title, setTitle] = useState("");
  const [acceptedTags, setAcceptedTags] = useState<string[]>([]);
  const [pollError, setPollError] = useState<Error | null>(null);
  const googleConnected = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("google") === "connected";

  const connectGoogle = useApiMutation(async (_: null, signal) =>
    api.getGoogleImportAuthorization(window.location.href, signal));
  const createImport = useApiMutation(async (_: null, signal) => {
    const input: ImportRequest = {
      sourceType: "google_docs",
      documentId: extractGoogleDocumentId(sourceValue),
    };
    return api.createImport(input, signal);
  });
  const applyImport = useApiMutation(
    (input: { jobId: string; title: string; tags: string[] }, signal) =>
      api.applyImport(input.jobId, {
        parentId: parentPageId,
        title: input.title,
        acceptedTags: input.tags,
      }, signal),
  );
  const diff = useMemo(
    () => job ? diffLines(job.currentMarkdown ?? "", job.previewMarkdown ?? "") : [],
    [job],
  );

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.getImport(job.id, controller.signal).then((updated) => {
        setPollError(null);
        setJob(updated);
        if (updated.status === "preview_ready") {
          setTitle(updated.suggestedTitle ?? updated.sourceLabel);
          setAcceptedTags(updated.suggestedTags ?? []);
        }
      }, (error: unknown) => {
        if (!controller.signal.aborted) {
          setPollError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }, 1_200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, job]);

  const chooseGoogleDocument = async () => {
    const selected = await picker?.pick();
    if (selected) {
      setSourceValue(selected.documentId);
      setSourceLabel(selected.name);
    }
  };

  const authorizeGoogle = async () => {
    const result = await connectGoogle.mutate(null);
    window.location.assign(result.authorizationUrl);
  };

  const startImport = async () => {
    const created = await createImport.mutate(null);
    setJob(created);
    if (created.status === "preview_ready") {
      setTitle(created.suggestedTitle ?? created.sourceLabel);
      setAcceptedTags(created.suggestedTags ?? []);
    }
  };

  const apply = async () => {
    if (!job) return;
    const page = await applyImport.mutate({ jobId: job.id, title, tags: acceptedTags });
    onApplied(page.page.id);
  };

  return (
    <div className="import-panel">
      <div className="drawer-section-title">
        <span>Knowledge intake</span>
        <h2>Google Docsを取り込む</h2>
        <p>変換結果と警告を確認してからWikiへ反映します。</p>
      </div>
      {!job ? (
        <div className="source-form">
          <button
            className="google-picker-button"
            disabled={connectGoogle.status === "loading"}
            onClick={() => { void authorizeGoogle().catch(() => undefined); }}
            type="button"
          >
            <span>G</span>
            {connectGoogle.status === "loading" ? "Googleへ接続中…" : "Googleアカウントを接続"}
          </button>
          {googleConnected && <small role="status">Googleアカウントを接続しました。</small>}
          {connectGoogle.status === "error" && (
            <div className="drawer-error" role="alert">{connectGoogle.error.message}</div>
          )}
          {picker && (
            <button onClick={() => { void chooseGoogleDocument().catch(() => undefined); }} type="button">
              Google Pickerで文書を選択
            </button>
          )}
          <label>
            Google Docs URL または Document ID
            <input
              onChange={(event) => {
                setSourceValue(event.target.value);
                setSourceLabel("");
              }}
              placeholder="https://docs.google.com/document/d/…/edit"
              value={sourceValue}
            />
          </label>
          {sourceLabel && <small>選択中: {sourceLabel}</small>}
          {createImport.status === "error" && (
            <div className="drawer-error" role="alert">{createImport.error.message}</div>
          )}
          <button
            className="import-start"
            disabled={!sourceValue.trim() || createImport.status === "loading"}
            onClick={() => { void startImport().catch(() => undefined); }}
            type="button"
          >
            {createImport.status === "loading" ? "変換を開始中…" : "プレビューを作成"}
          </button>
        </div>
      ) : (
        <div className="import-preview">
          <div className="import-job-state">
            <span className={`is-${job.status}`}>
              {job.status === "preview_ready" ? "プレビュー準備完了" : job.status}
            </span>
            <small>{job.sourceLabel}</small>
          </div>
          {pollError && <div className="drawer-error" role="alert">{pollError.message}</div>}
          {job.error && <div className="drawer-error" role="alert">{job.error.message}</div>}
          {job.warnings.map((warning) => (
            <div className="inline-warning" key={warning}>{warning}</div>
          ))}
          <label>
            ページタイトル
            <input onChange={(event) => { setTitle(event.target.value); }} value={title} />
          </label>
          {job.suggestedTags && (
            <div className="suggested-tags">
              <span>提案タグ</span>
              {job.suggestedTags.map((tag) => (
                <button
                  aria-pressed={acceptedTags.includes(tag)}
                  key={tag}
                  onClick={() => {
                    setAcceptedTags((current) => current.includes(tag)
                      ? current.filter((value) => value !== tag)
                      : [...current, tag]);
                  }}
                  type="button"
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
          <div className="diff-header">
            <strong>取り込みプレビュー</strong>
            <span><i className="added" />追加 <i className="removed" />削除</span>
          </div>
          <pre className="diff-view" aria-label="取り込み差分">
            {diff.map((line, index) => (
              <span className={`is-${line.kind}`} key={`${String(index)}-${line.kind}`}>
                <b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</b>
                {line.value || " "}
              </span>
            ))}
          </pre>
          {applyImport.status === "error" && (
            <div className="drawer-error" role="alert">{applyImport.error.message}</div>
          )}
          <div className="import-actions">
            <button onClick={() => { setJob(null); }} type="button">戻る</button>
            <button
              disabled={
                job.status !== "preview_ready" ||
                !title.trim() ||
                applyImport.status === "loading"
              }
              onClick={() => { void apply().catch(() => undefined); }}
              type="button"
            >
              Wikiへ反映
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
