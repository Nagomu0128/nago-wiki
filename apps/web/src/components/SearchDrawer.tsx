import { useState } from "react";
import { ApiFailure, useApiMutation, type AnswerState, type SearchMode, type WikiApi } from "../api";

export type ExploreMode = "search" | "ai";

interface SearchDrawerProps {
  api: WikiApi;
  mode: ExploreMode;
  onModeChange: (mode: ExploreMode) => void;
  onSelectPage: (pageId: string) => void;
}

const answerLabels: Record<AnswerState, { label: string; detail: string }> = {
  wiki: { label: "Wikiに基づく回答", detail: "回答はWiki内の根拠だけで構成されています。" },
  mixed: { label: "Wiki＋一般知識", detail: "一般知識による補足を分けて表示しています。" },
  general: { label: "一般知識による回答", detail: "Wiki内に根拠が見つかりませんでした。" },
  insufficient: { label: "根拠不足", detail: "回答に十分な根拠を取得できませんでした。" },
};

function MutationError({ error }: { error: Error }) {
  const requestId = error instanceof ApiFailure ? error.requestId : undefined;
  return <div className="drawer-error" role="alert"><strong>処理に失敗しました</strong><span>{error.message}</span>{requestId && <small>Request ID: {requestId}</small>}</div>;
}

export function SearchDrawer({ api, mode, onModeChange, onSelectPage }: SearchDrawerProps) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [knowledgeMode, setKnowledgeMode] = useState<"wiki_only" | "wiki_plus_general">("wiki_plus_general");
  const search = useApiMutation((input: { query: string; mode: SearchMode }, signal) => api.search({ ...input, limit: 20 }, signal));
  const answer = useApiMutation((input: { query: string; knowledgeMode: "wiki_only" | "wiki_plus_general" }, signal) => api.answer(input.query, input.knowledgeMode, signal));

  const submit = () => {
    const value = query.trim();
    if (!value) return;
    if (mode === "search") void search.mutate({ query: value, mode: searchMode });
    else void answer.mutate({ query: value, knowledgeMode });
  };

  return (
    <div className="explore-panel">
      <div className="segmented-control explore-tabs" role="tablist" aria-label="検索とAI">
        <button aria-selected={mode === "search"} onClick={() => { onModeChange("search"); }} role="tab" type="button">検索</button>
        <button aria-selected={mode === "ai"} onClick={() => { onModeChange("ai"); }} role="tab" type="button">AI回答</button>
      </div>

      <div className="explore-intro">
        <span className="drawer-eyebrow">{mode === "search" ? "Knowledge retrieval" : "Grounded answer"}</span>
        <h2>{mode === "search" ? "知識を横断して探す" : "Wikiに質問する"}</h2>
        <p>{mode === "search" ? "タイトル、本文、意味の近さを組み合わせて検索します。" : "根拠と一般知識の境界を明示して回答します。"}</p>
      </div>

      <label className="drawer-query" htmlFor="workspace-search">
        <span className="sr-only">{mode === "search" ? "Wikiを検索" : "Wikiへの質問"}</span>
        <textarea
          id="workspace-search"
          onChange={(event) => { setQuery(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={mode === "search" ? "例: Cloudflareの認可設計" : "例: このWikiの検索結果はどう認可される？"}
          rows={3}
          value={query}
        />
        <button disabled={!query.trim() || search.status === "loading" || answer.status === "loading"} onClick={submit} type="button">{mode === "search" ? "検索" : "回答を作成"}</button>
      </label>

      {mode === "search" ? (
        <>
          <div className="filter-pills" role="group" aria-label="検索モード">
            {(["hybrid", "semantic", "keyword"] as const).map((value) => (
              <button aria-pressed={searchMode === value} key={value} onClick={() => { setSearchMode(value); }} type="button">
                {value === "hybrid" ? "ハイブリッド" : value === "semantic" ? "意味検索" : "キーワード"}
              </button>
            ))}
          </div>
          {search.status === "loading" && <div className="drawer-loading" role="status"><i /><span>検索中…</span></div>}
          {search.status === "error" && <MutationError error={search.error} />}
          {search.data && (
            <div className="search-results" aria-live="polite">
              <div className="results-heading"><span>{search.data.hits.length}件</span><small>権限確認済み</small></div>
              {search.data.hits.length === 0 && <div className="empty-state"><strong>一致するページがありません</strong><span>言葉を短くするか、意味検索を試してください。</span></div>}
              {search.data.hits.map((hit) => (
                <button className="search-hit" key={`${hit.pageId}-${hit.contentHash}`} onClick={() => { onSelectPage(hit.pageId); }} type="button">
                  <span className={`source-badge is-${hit.source}`}>{hit.source === "semantic" ? "意味" : hit.source === "keyword" ? "本文" : "タイトル"}</span>
                  <strong>{hit.title}</strong>
                  <small>{hit.path}</small>
                  <p>{hit.snippet}</p>
                  <span className="score">{Math.round(hit.score * 100)}%</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <label className="knowledge-mode-toggle">
            <input checked={knowledgeMode === "wiki_plus_general"} onChange={(event) => { setKnowledgeMode(event.target.checked ? "wiki_plus_general" : "wiki_only"); }} type="checkbox" />
            <span><strong>一般知識で補足</strong><small>Wikiに根拠がない部分は明確に区別します</small></span>
          </label>
          {answer.status === "loading" && <div className="answer-loading" role="status"><i /><i /><i /><span>根拠を確認しながら回答を作成中…</span></div>}
          {answer.status === "error" && <MutationError error={answer.error} />}
          {answer.data && (
            <div className="answer-card" aria-live="polite">
              <div className={`answer-state is-${answer.data.state}`}><strong>{answerLabels[answer.data.state].label}</strong><span>{answerLabels[answer.data.state].detail}</span></div>
              <div className="answer-markdown">{answer.data.answerMarkdown}</div>
              {answer.data.citations.length > 0 && (
                <div className="citations">
                  <h3>引用元</h3>
                  {answer.data.citations.map((citation, index) => (
                    <button key={citation.id} onClick={() => { onSelectPage(citation.pageId); }} type="button">
                      <span>{index + 1}</span><div><strong>{citation.title}</strong><small>{citation.path}</small><p>{citation.snippet}</p></div>
                    </button>
                  ))}
                </div>
              )}
              <small className="request-id">Request ID: {answer.data.requestId}</small>
            </div>
          )}
        </>
      )}
    </div>
  );
}
