import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/frame.css";
import { replaceAll } from "@milkdown/kit/utils";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import * as Y from "yjs";
import { RevisionConflictFailure, type PageResource, type WikiApi } from "../api";
import {
  localMarkdownOrigin,
  replaceSharedMarkdown,
  type RealtimeProviderFactory,
  type RealtimeStatus,
} from "../realtime";
import {
  completeWikiLink,
  createApiWikiLinkSuggestionProvider,
  extractWikiLinkQuery,
  type WikiLinkCandidate,
  type WikiLinkSuggestionProvider,
} from "./wikiLinks";

type EditorMode = "visual" | "source";
type SaveStatus = "saved" | "dirty" | "saving" | "offline" | "error" | "conflict";

export interface EditorSurfaceHandle {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
}

export interface CrepeSurfaceProps {
  document: Y.Doc;
  initialMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  onRemoteMarkdownChange?: (markdown: string) => void;
  readOnly: boolean;
}

export type EditorSurfaceComponent = ForwardRefExoticComponent<CrepeSurfaceProps & RefAttributes<EditorSurfaceHandle>>;

const CrepeSurface = forwardRef<EditorSurfaceHandle, CrepeSurfaceProps>(function CrepeSurface(
  { document, initialMarkdown, onMarkdownChange, onRemoteMarkdownChange, readOnly },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  const onRemoteMarkdownChangeRef = useRef(onRemoteMarkdownChange);
  const initialMarkdownRef = useRef(initialMarkdown);
  const readOnlyRef = useRef(readOnly);
  const applyingRemoteRef = useRef(false);

  useEffect(() => { onMarkdownChangeRef.current = onMarkdownChange; }, [onMarkdownChange]);
  useEffect(() => { onRemoteMarkdownChangeRef.current = onRemoteMarkdownChange; }, [onRemoteMarkdownChange]);

  useImperativeHandle(ref, () => ({
    getMarkdown: () => crepeRef.current?.getMarkdown() ?? initialMarkdownRef.current,
    setMarkdown: (markdown) => {
      crepeRef.current?.editor.action(replaceAll(markdown));
    },
  }), []);

  useEffect(() => {
    if (!rootRef.current) return;
    let disposed = false;
    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: initialMarkdownRef.current,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: "考えを書き始める…" },
      },
    });
    const sharedMarkdown = document.getText("markdown");
    const applySharedMarkdown = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === localMarkdownOrigin || !crepeRef.current) return;
      const nextMarkdown = sharedMarkdown.toJSON();
      if (crepeRef.current.getMarkdown() === nextMarkdown) return;
      applyingRemoteRef.current = true;
      crepeRef.current.editor.action(replaceAll(nextMarkdown));
      applyingRemoteRef.current = false;
      onRemoteMarkdownChangeRef.current?.(nextMarkdown);
    };
    sharedMarkdown.observe(applySharedMarkdown);
    crepe.on((listener) => {
      listener.markdownUpdated((_context, markdown, previousMarkdown) => {
        if (!applyingRemoteRef.current && markdown !== previousMarkdown) onMarkdownChangeRef.current(markdown);
      });
    });
    void crepe.create().then(() => {
      if (disposed) {
        void crepe.destroy();
        return;
      }
      crepeRef.current = crepe;
      crepe.setReadonly(readOnlyRef.current);
      const synchronizedMarkdown = sharedMarkdown.toJSON();
      if (synchronizedMarkdown && synchronizedMarkdown !== crepe.getMarkdown()) {
        applyingRemoteRef.current = true;
        crepe.editor.action(replaceAll(synchronizedMarkdown));
        applyingRemoteRef.current = false;
        onRemoteMarkdownChangeRef.current?.(synchronizedMarkdown);
      }
      const editor = rootRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      editor?.setAttribute("aria-label", "Markdown本文");
      rootRef.current?.querySelectorAll<HTMLElement>("button:not([aria-label])").forEach((button) => {
        if (!button.textContent.trim()) button.setAttribute("aria-label", "エディター操作");
      });
      rootRef.current?.querySelectorAll<HTMLElement>("a:not([aria-label])").forEach((link) => {
        if (!link.textContent.trim()) link.setAttribute("aria-label", "本文内のリンク");
      });
    });
    return () => {
      disposed = true;
      sharedMarkdown.unobserve(applySharedMarkdown);
      crepeRef.current = null;
      void crepe.destroy();
    };
  }, [document]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    crepeRef.current?.setReadonly(readOnly);
  }, [readOnly]);

  return <div aria-label="ビジュアルMarkdownエディター" className="crepe-surface" ref={rootRef} role="group" />;
});

interface KnowledgeEditorProps {
  resource: PageResource;
  api: WikiApi;
  realtimeFactory: RealtimeProviderFactory;
  suggestionProvider?: WikiLinkSuggestionProvider;
  onSaved?: (resource: PageResource) => void;
  onMoved?: (resource: PageResource) => void;
  onPageCreated?: (resource: PageResource) => void;
  onRequestMove?: () => void;
  onTrashed?: (pageIds: string[]) => void;
  onOpenBacklinks?: () => void;
  onOpenComments?: () => void;
  onOpenTags?: () => void;
  onOpenVersions?: () => void;
  surfaceComponent?: EditorSurfaceComponent;
}

const saveLabels: Record<SaveStatus, string> = {
  saved: "保存済み",
  dirty: "未保存の変更",
  saving: "保存中…",
  offline: "オフライン",
  error: "保存に失敗",
  conflict: "競合を確認",
};

export function KnowledgeEditor({
  resource,
  api,
  realtimeFactory,
  suggestionProvider,
  onSaved,
  onMoved,
  onPageCreated,
  onRequestMove,
  onTrashed,
  onOpenBacklinks,
  onOpenComments,
  onOpenTags,
  onOpenVersions,
  surfaceComponent: Surface = CrepeSurface,
}: KnowledgeEditorProps) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const [title, setTitle] = useState(resource.page.title);
  const [markdown, setMarkdown] = useState(resource.page.bodyMd);
  const [sourceMarkdown, setSourceMarkdown] = useState(resource.page.bodyMd);
  const [revision, setRevision] = useState(resource.page.revision);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [conflict, setConflict] = useState<RevisionConflictFailure | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [permission, setPermission] = useState(resource.permission);
  const [normalizationWarning, setNormalizationWarning] = useState(false);
  const [wikiQuery, setWikiQuery] = useState<string | null>(null);
  const [wikiCandidates, setWikiCandidates] = useState<WikiLinkCandidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [creatingWikiPage, setCreatingWikiPage] = useState(false);
  const document = useMemo(() => new Y.Doc(), []);
  const surfaceRef = useRef<EditorSurfaceHandle>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const conflictDialogRef = useRef<HTMLDivElement>(null);
  const editGenerationRef = useRef(0);
  const suggestions = useMemo(() => suggestionProvider ?? createApiWikiLinkSuggestionProvider(api), [api, suggestionProvider]);
  // Offline editing is intentionally outside v1. Keeping the surface locked
  // until the first Yjs sync prevents an independently seeded document from
  // merging duplicate Markdown into the canonical PageRoom document.
  const readOnly = permission === "viewer" || realtimeStatus !== "connected";
  const brokenLinkTitle = wikiQuery === null ? "" : wikiLinkPageTitle(wikiQuery);
  const canCreateWikiPage = !readOnly && brokenLinkTitle.length > 0;
  const wikiOptionCount = wikiCandidates.length + (canCreateWikiPage ? 1 : 0);

  useEffect(() => () => { document.destroy(); }, [document]);

  useEffect(() => {
    const session = realtimeFactory.connect({ pageId: resource.page.id, document, permission: resource.permission });
    const unsubscribeStatus = session.subscribeStatus((status) => { setRealtimeStatus(status); });
    const unsubscribePermission = session.subscribePermission((nextPermission) => { setPermission(nextPermission); });
    return () => {
      unsubscribeStatus();
      unsubscribePermission();
      session.destroy();
    };
  }, [document, realtimeFactory, resource.page.id, resource.permission]);

  useEffect(() => {
    if (wikiQuery === null) return;
    const controller = new AbortController();
    void suggestions.search(wikiQuery, controller.signal).then((candidates) => {
      if (!controller.signal.aborted) {
        setWikiCandidates(candidates);
        setCandidateIndex(0);
      }
    }, () => {
      if (!controller.signal.aborted) setWikiCandidates([]);
    });
    return () => { controller.abort(); };
  }, [suggestions, wikiQuery]);

  useEffect(() => {
    if (!conflict) return;
    const dialog = conflictDialogRef.current;
    if (!dialog) return;
    const previousFocus = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    focusable[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && globalThis.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && globalThis.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [conflict]);

  const markChanged = useCallback((nextMarkdown: string) => {
    replaceSharedMarkdown(document, nextMarkdown);
    editGenerationRef.current += 1;
    setMarkdown(nextMarkdown);
    setSourceMarkdown(nextMarkdown);
    setSaveStatus(realtimeStatus === "connected" ? "saved" : "dirty");
    setSaveError(null);
    setWikiQuery(extractWikiLinkQuery(nextMarkdown));
  }, [document, realtimeStatus]);

  const acceptRemoteMarkdown = useCallback((nextMarkdown: string) => {
    editGenerationRef.current += 1;
    setMarkdown(nextMarkdown);
    setSourceMarkdown(nextMarkdown);
    setWikiQuery(extractWikiLinkQuery(nextMarkdown));
  }, []);

  const save = useCallback(async (baseRevision = revision) => {
    if (readOnly) return;
    const generation = editGenerationRef.current;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const updated = await api.updatePage(resource.page.id, {
        baseRevision,
        title,
      });
      setRevision(updated.page.revision);
      setConflict(null);
      setSaveStatus(editGenerationRef.current === generation ? "saved" : "dirty");
      onSaved?.(updated);
    } catch (error) {
      if (error instanceof RevisionConflictFailure) {
        let resolvedConflict = error;
        if (!error.latest) {
          try {
            const latest = await api.getPage(resource.page.id);
            resolvedConflict = new RevisionConflictFailure(error.message, error.requestId, latest, error.details);
          } catch {
            // The original conflict remains actionable through a retry after the page is reachable again.
          }
        }
        setConflict(resolvedConflict);
        setSaveStatus("conflict");
      } else {
        setSaveError(error instanceof Error ? error : new Error(String(error)));
        setSaveStatus("error");
      }
    }
  }, [api, onSaved, readOnly, resource.page.id, revision, title]);

  useEffect(() => {
    if (saveStatus !== "dirty") return;
    const timer = window.setTimeout(() => { void save(); }, 900);
    return () => { window.clearTimeout(timer); };
  }, [save, saveStatus]);

  const changeTitle = (nextTitle: string) => {
    editGenerationRef.current += 1;
    setTitle(nextTitle);
    setSaveStatus("dirty");
  };

  const switchMode = (nextMode: EditorMode) => {
    if (nextMode === mode) return;
    if (nextMode === "source") {
      const current = surfaceRef.current?.getMarkdown() ?? markdown;
      setSourceMarkdown(current);
      setMarkdown(current);
      setMode("source");
      window.setTimeout(() => { sourceRef.current?.focus(); });
      return;
    }
    surfaceRef.current?.setMarkdown(sourceMarkdown);
    markChanged(sourceMarkdown);
    setMode("visual");
    window.setTimeout(() => {
      const normalized = surfaceRef.current?.getMarkdown();
      setNormalizationWarning(Boolean(normalized && normalized.trim() !== sourceMarkdown.trim()));
    });
  };

  const selectWikiCandidate = (candidate: WikiLinkCandidate) => {
    if (mode === "source") {
      const cursor = sourceRef.current?.selectionStart ?? sourceMarkdown.length;
      const completed = completeWikiLink(sourceMarkdown, candidate, cursor);
      markChanged(completed.markdown);
      setSourceMarkdown(completed.markdown);
      setWikiQuery(null);
      window.setTimeout(() => {
        sourceRef.current?.focus();
        sourceRef.current?.setSelectionRange(completed.cursor, completed.cursor);
      });
      return;
    }
    const completed = completeWikiLink(markdown, candidate);
    surfaceRef.current?.setMarkdown(completed.markdown);
    markChanged(completed.markdown);
    setWikiQuery(null);
  };

  const createLinkedPage = async () => {
    if (!canCreateWikiPage || creatingWikiPage) return;
    setCreatingWikiPage(true);
    setSaveError(null);
    try {
      const created = await api.createPage({
        parentId: null,
        title: brokenLinkTitle,
      });
      selectWikiCandidate({
        pageId: created.page.id,
        path: `/${created.page.slug}`,
        title: created.page.title,
      });
      onPageCreated?.(created);
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      setSaveStatus("error");
    } finally {
      setCreatingWikiPage(false);
    }
  };

  const handleSourceKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (wikiOptionCount === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCandidateIndex((current) => (current + delta + wikiOptionCount) % wikiOptionCount);
    }
    if (event.key === "Enter" && wikiQuery !== null) {
      const candidate = wikiCandidates[candidateIndex];
      if (candidate) {
        event.preventDefault();
        selectWikiCandidate(candidate);
      } else if (canCreateWikiPage && candidateIndex === wikiCandidates.length) {
        event.preventDefault();
        void createLinkedPage();
      }
    }
    if (event.key === "Escape") setWikiQuery(null);
  };

  const loadLatest = () => {
    const latest = conflict?.latest;
    if (!latest) return;
    setTitle(latest.page.title);
    setMarkdown(latest.page.bodyMd);
    setSourceMarkdown(latest.page.bodyMd);
    setRevision(latest.page.revision);
    replaceSharedMarkdown(document, latest.page.bodyMd);
    surfaceRef.current?.setMarkdown(latest.page.bodyMd);
    setConflict(null);
    setSaveStatus("saved");
  };

  const moveToRoot = async () => {
    const updated = await api.movePage(resource.page.id, { parentId: null });
    setRevision(updated.page.revision);
    onMoved?.(updated);
  };

  const trash = async () => {
    const result = await api.trashPage(resource.page.id);
    onTrashed?.(result.pageIds);
  };

  const runPageAction = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      setSaveStatus("error");
    });
  };

  return (
    <article className="knowledge-editor">
      <div className="editor-meta-row">
        <span>{new Date(resource.page.updatedAt).toLocaleDateString("ja-JP")}</span>
        <span>rev. {revision}</span>
        <span className={`save-indicator is-${saveStatus}`} aria-live="polite"><i />{saveLabels[saveStatus]}</span>
        <span className={`realtime-indicator is-${realtimeStatus}`}>{realtimeStatus === "connected" ? "リアルタイム接続" : "再接続待ち"}</span>
      </div>

      <input
        aria-label="ページタイトル"
        className="page-title-input"
        disabled={readOnly}
        maxLength={500}
        onChange={(event) => { changeTitle(event.target.value); }}
        value={title}
      />

      <div className="page-tag-row" aria-label="ページのタグ">
        {resource.tags.map((tag) => <span key={tag.id}>#{tag.name}</span>)}
        <button onClick={onOpenTags} type="button">{resource.tags.length === 0 ? "+ タグを追加" : "編集"}</button>
      </div>

      <div className="editor-commandbar">
        <div className="mode-switch" role="group" aria-label="編集モード">
          <button aria-pressed={mode === "visual"} onClick={() => { switchMode("visual"); }} type="button">ビジュアル</button>
          <button aria-pressed={mode === "source"} onClick={() => { switchMode("source"); }} type="button">Markdown</button>
        </div>
        <span className="editor-hint">`#`、`- [ ]`、`[[` の入力ショートカット</span>
        <div className="editor-actions">
          <button className="text-button" onClick={onOpenTags} type="button">タグ</button>
          <button className="text-button" onClick={onOpenBacklinks} type="button">リンク元</button>
          <button className="text-button" onClick={onOpenComments} type="button">コメント</button>
          <button className="text-button" onClick={onOpenVersions} type="button">履歴</button>
          <details className="page-menu">
            <summary aria-label="ページ操作">•••</summary>
            <div>
              <button onClick={() => { runPageAction(moveToRoot); }} type="button">ルートへ移動</button>
              <button onClick={onRequestMove} type="button">ページを移動…</button>
              <button className="danger" onClick={() => { runPageAction(trash); }} type="button">ゴミ箱へ移動</button>
            </div>
          </details>
        </div>
      </div>

      {normalizationWarning && <div className="inline-warning" role="status">Markdownを正規化しました。保存前に差分を確認してください。</div>}
      {saveError && <div className="inline-warning is-error" role="alert">{saveError.message}<button onClick={() => { void save(); }} type="button">再試行</button></div>}
      {permission === "viewer" && <div className="inline-warning" role="status">このページは閲覧専用です。</div>}
      {permission !== "viewer" && realtimeStatus !== "connected" && (
        <div className="inline-warning" role="status">
          リアルタイム同期を確立しています。接続後に編集できます。
        </div>
      )}

      <div className="editor-canvas">
        <div hidden={mode !== "visual"}>
          <Surface
            document={document}
            initialMarkdown={resource.page.bodyMd}
            onMarkdownChange={markChanged}
            onRemoteMarkdownChange={acceptRemoteMarkdown}
            readOnly={readOnly}
            ref={surfaceRef}
          />
        </div>
        {mode === "source" && (
          <textarea
            aria-label="Markdownソース"
            className="markdown-source"
            disabled={readOnly}
            onChange={(event) => {
              const next = event.target.value;
              setSourceMarkdown(next);
              markChanged(next);
              setWikiQuery(extractWikiLinkQuery(next, event.target.selectionStart));
            }}
            onKeyDown={handleSourceKeyDown}
            ref={sourceRef}
            spellCheck="false"
            value={sourceMarkdown}
          />
        )}

        {wikiQuery !== null && wikiOptionCount > 0 && (
          <div aria-label="Wikiリンク候補" className="wiki-link-popover" role="listbox">
            <small>ページへリンク</small>
            {wikiCandidates.map((candidate, index) => (
              <button
                aria-selected={index === candidateIndex}
                key={candidate.pageId}
                onClick={() => { selectWikiCandidate(candidate); }}
                role="option"
                type="button"
              >
                <strong>{candidate.title}</strong><span>{candidate.path}</span>
              </button>
            ))}
            {canCreateWikiPage && (
              <button
                aria-selected={candidateIndex === wikiCandidates.length}
                className="wiki-link-create"
                disabled={creatingWikiPage}
                onClick={() => { void createLinkedPage(); }}
                role="option"
                type="button"
              >
                <strong>{creatingWikiPage ? "作成中…" : `「${brokenLinkTitle}」を新規作成`}</strong>
                <span>作成後、この位置へWikiリンクを挿入します</span>
              </button>
            )}
          </div>
        )}
      </div>

      {conflict && (
        <div aria-describedby="conflict-description" aria-labelledby="conflict-title" aria-modal="true" className="conflict-dialog" ref={conflictDialogRef} role="dialog">
          <div>
            <span className="conflict-mark">!</span>
            <h2 id="conflict-title">別の編集が先に保存されました</h2>
            <p id="conflict-description">自分の変更は失われていません。最新版を読み込むか、最新版のrevisionを基準に自分の内容を再保存してください。</p>
            {conflict.latest && <div className="conflict-summary"><span>サーバー</span><strong>rev. {conflict.latest.page.revision}</strong><span>自分</span><strong>rev. {revision} から編集</strong></div>}
            <div className="dialog-actions">
              <button className="button" disabled={!conflict.latest} onClick={loadLatest} type="button">最新版を読み込む</button>
              <button className="button button-primary" disabled={!conflict.latest} onClick={() => { if (conflict.latest) void save(conflict.latest.page.revision); }} type="button">自分の内容で再保存</button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function wikiLinkPageTitle(query: string): string {
  const target = query.split("|", 1)[0]?.trim() ?? "";
  return target.split("/").filter(Boolean).at(-1)?.trim().slice(0, 500) ?? "";
}
