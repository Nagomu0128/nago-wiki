import { useMemo, useState } from "react";
import { useApiMutation, type ImportJob, type ImportRequest, type ImportSourceType, type WikiApi } from "../api";
import { diffLines } from "./diff";

export interface GoogleDocumentPicker {
  pick(): Promise<{ documentId: string; name: string } | null>;
}

interface ImportDrawerProps {
  api: WikiApi;
  parentPageId: string | null;
  picker?: GoogleDocumentPicker;
  onApplied: (pageId: string) => void;
}

const sourceOptions: { value: ImportSourceType; label: string }[] = [
  { value: "google_docs", label: "Google Docs" },
  { value: "markdown", label: "Markdown" },
  { value: "pdf", label: "PDF" },
  { value: "url", label: "公開URL" },
  { value: "paste", label: "貼り付け" },
];

export function ImportDrawer({ api, parentPageId, picker, onApplied }: ImportDrawerProps) {
  const [sourceType, setSourceType] = useState<ImportSourceType>("google_docs");
  const [sourceValue, setSourceValue] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [title, setTitle] = useState("");
  const [acceptedTags, setAcceptedTags] = useState<string[]>([]);
  const createImport = useApiMutation(async (_: null, signal) => {
    const input: ImportRequest = sourceType === "google_docs"
      ? { sourceType, documentId: sourceValue }
      : sourceType === "url"
        ? { sourceType, sourceUrl: sourceValue }
        : { sourceType, ...(sourceLabel ? { filename: sourceLabel } : {}), ...(sourceValue ? { content: sourceValue } : {}) };
    return api.createImport(input, signal);
  });
  const applyImport = useApiMutation((input: { jobId: string; title: string; tags: string[] }, signal) => api.applyImport(input.jobId, {
    parentId: parentPageId,
    title: input.title,
    acceptedTags: input.tags,
  }, signal));
  const diff = useMemo(() => job ? diffLines(job.currentMarkdown ?? "", job.previewMarkdown ?? "") : [], [job]);

  const chooseGoogleDocument = async () => {
    const selected = await picker?.pick();
    if (selected) {
      setSourceValue(selected.documentId);
      setSourceLabel(selected.name);
    }
  };

  const startImport = async () => {
    const created = await createImport.mutate(null);
    setJob(created);
    setTitle(created.suggestedTitle ?? created.sourceLabel);
    setAcceptedTags(created.suggestedTags ?? []);
  };

  const apply = async () => {
    if (!job) return;
    const page = await applyImport.mutate({ jobId: job.id, title, tags: acceptedTags });
    onApplied(page.page.id);
  };

  return (
    <div className="import-panel">
      <div className="drawer-section-title"><span>Knowledge intake</span><h2>知識を取り込む</h2><p>変換結果と差分を確認してからWikiへ反映します。</p></div>
      {!job ? (
        <>
          <div className="source-options" role="tablist" aria-label="取り込み元">
            {sourceOptions.map((option) => <button aria-selected={sourceType === option.value} key={option.value} onClick={() => { setSourceType(option.value); setSourceValue(""); setSourceLabel(""); }} role="tab" type="button">{option.label}</button>)}
          </div>
          <div className="source-form">
            {sourceType === "google_docs" && (
              <>
                <button className="google-picker-button" disabled={!picker} onClick={() => { void chooseGoogleDocument(); }} type="button"><span>G</span>{sourceLabel || "Google Pickerで文書を選択"}</button>
                {!picker && <small>Google Picker adapter接続後に利用できます。開発時はDocument IDを入力できます。</small>}
                <label>Document ID<input onChange={(event) => { setSourceValue(event.target.value); }} placeholder="1AbC…" value={sourceValue} /></label>
              </>
            )}
            {sourceType === "url" && <label>公開URL<input onChange={(event) => { setSourceValue(event.target.value); }} placeholder="https://example.com/article" type="url" value={sourceValue} /></label>}
            {(sourceType === "markdown" || sourceType === "pdf") && (
              <label className="file-drop">ファイルを選択<input accept={sourceType === "pdf" ? ".pdf,application/pdf" : ".md,.markdown,text/markdown"} onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setSourceLabel(file.name);
                if (sourceType === "markdown") void file.text().then((content) => { setSourceValue(content); });
              }} type="file" /><span>{sourceLabel || `${sourceType === "pdf" ? "PDF" : "Markdown"}をここへ選択`}</span></label>
            )}
            {sourceType === "paste" && <label>本文<textarea onChange={(event) => { setSourceValue(event.target.value); }} placeholder="HTMLまたはテキストを貼り付け…" rows={9} value={sourceValue} /></label>}
            {createImport.status === "error" && <div className="drawer-error" role="alert">{createImport.error.message}</div>}
            <button className="import-start" disabled={!sourceValue && !sourceLabel || createImport.status === "loading"} onClick={() => { void startImport(); }} type="button">{createImport.status === "loading" ? "変換を開始中…" : "プレビューを作成"}</button>
          </div>
        </>
      ) : (
        <div className="import-preview">
          <div className="import-job-state"><span className={`is-${job.status}`}>{job.status === "preview_ready" ? "プレビュー準備完了" : job.status}</span><small>{job.sourceLabel}</small></div>
          {job.warnings.map((warning) => <div className="inline-warning" key={warning}>{warning}</div>)}
          <label>ページタイトル<input onChange={(event) => { setTitle(event.target.value); }} value={title} /></label>
          {job.suggestedTags && <div className="suggested-tags"><span>AIによるタグ候補</span>{job.suggestedTags.map((tag) => <button aria-pressed={acceptedTags.includes(tag)} key={tag} onClick={() => { setAcceptedTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag]); }} type="button">#{tag}</button>)}</div>}
          <div className="diff-header"><strong>現在の本文との差分</strong><span><i className="added" />追加 <i className="removed" />削除</span></div>
          <pre className="diff-view" aria-label="取り込み差分">{diff.map((line, index) => <span className={`is-${line.kind}`} key={`${String(index)}-${line.kind}`}><b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</b>{line.value || " "}</span>)}</pre>
          {applyImport.status === "error" && <div className="drawer-error" role="alert">{applyImport.error.message}</div>}
          <div className="import-actions"><button onClick={() => { setJob(null); }} type="button">戻る</button><button disabled={!title.trim() || applyImport.status === "loading"} onClick={() => { void apply(); }} type="button">Wikiへ反映</button></div>
        </div>
      )}
    </div>
  );
}
