import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiFailure, createWikiApi, useApiQuery, type PageResource, type PageTreeNode, type WikiApi } from "./api";
import {
  AccountLinkDrawer,
  ActivityDrawer,
  ImportDrawer,
  KnowledgeOrganizerDrawer,
  SearchDrawer,
  type KnowledgeOrganizerMode,
} from "./components";
import { KnowledgeEditor } from "./editor";
import { NativeYjsRealtimeProviderFactory, type RealtimeProviderFactory } from "./realtime";

const defaultApi = createWikiApi();
const defaultRealtimeFactory = new NativeYjsRealtimeProviderFactory();

type DrawerMode = "search" | "ai" | "comments" | "versions" | "import" | "account" | KnowledgeOrganizerMode;

function isKnowledgeOrganizerMode(mode: DrawerMode): mode is KnowledgeOrganizerMode {
  return mode === "recent" || mode === "favorites" || mode === "trash" || mode === "tags" || mode === "backlinks" || mode === "move";
}

interface AppProps {
  api?: WikiApi;
  realtimeFactory?: RealtimeProviderFactory;
}

function flattenTree(nodes: PageTreeNode[]): PageTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function Icon({ name }: { name: "book" | "chevron" | "plus" | "search" | "spark" | "menu" | "more" | "close" | "lock" | "star" | "clock" | "trash" | "move" }) {
  const paths = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 5.5v16" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    spark: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7z" /></>,
    menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
    trash: <><path d="M4 7h16" /><path d="m9 7 .5-2h5l.5 2" /><path d="m7 7 1 13h8l1-13" /></>,
    move: <><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M18 9l3 3-3 3M15 18l-3 3-3-3M6 15l-3-3 3-3" /></>,
  };
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function ErrorNotice({ error, retry }: { error: Error; retry: () => void }) {
  const requestId = error instanceof ApiFailure ? error.requestId : undefined;
  return (
    <div className="notice notice-error" role="alert">
      <div>
        <strong>読み込みに失敗しました</strong>
        <span>{error.message}</span>
        {requestId && <small>Request ID: {requestId}</small>}
      </div>
      <button className="button button-quiet" type="button" onClick={retry}>再試行</button>
    </div>
  );
}

interface TreeProps {
  nodes: PageTreeNode[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  onRequestMove: (id: string) => void;
}

function PageTree({ nodes, activeId, onMove, onRequestMove, onSelect }: TreeProps) {
  const items = useMemo(() => flattenTree(nodes), [nodes]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = items.findIndex((item) => item.id === id);
    const nextIndex = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : -1;
    const next = items[nextIndex];
    if (nextIndex >= 0 && next) {
      event.preventDefault();
      const target = event.currentTarget.closest("[role=tree]")?.querySelectorAll<HTMLButtonElement>("[role=treeitem]")[nextIndex];
      target?.focus();
      onSelect(next.id);
    }
  };

  const renderNodes = (treeNodes: PageTreeNode[], level: number) => treeNodes.map((node) => (
    <li
      key={node.id}
      onDragOver={(event) => { if (draggingId && draggingId !== node.id) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (draggingId && draggingId !== node.id) onMove(draggingId, node.id); setDraggingId(null); }}
      role="none"
    >
      <div className={`tree-row ${draggingId === node.id ? "is-dragging" : ""}`}>
        <button
        aria-current={node.id === activeId ? "page" : undefined}
        aria-level={level}
        className="tree-item"
          draggable
          onClick={() => { onSelect(node.id); }}
          onDragEnd={() => { setDraggingId(null); }}
          onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); setDraggingId(node.id); }}
          onKeyDown={(event) => { onKeyDown(event, node.id); }}
          role="treeitem"
          style={{ paddingInlineStart: `${String(12 + (level - 1) * 16)}px` }}
          tabIndex={node.id === activeId || (!activeId && items[0]?.id === node.id) ? 0 : -1}
          type="button"
        >
        <span className={`tree-caret ${node.children.length ? "" : "tree-caret-empty"}`}><Icon name="chevron" /></span>
        <span className="tree-page-mark" aria-hidden="true">§</span>
        <span className="tree-label">{node.title}</span>
        {node.accessMode === "restricted" && <Icon name="lock" />}
        </button>
        <button aria-label={`${node.title}を移動`} className="tree-move-button" onClick={() => { onRequestMove(node.id); }} type="button"><Icon name="move" /></button>
      </div>
      {node.children.length > 0 && <ul role="group">{renderNodes(node.children, level + 1)}</ul>}
    </li>
  ));

  return <ul aria-label="ページ" className="page-tree" role="tree">{renderNodes(nodes, 1)}</ul>;
}

export function App({ api = defaultApi, realtimeFactory = defaultRealtimeFactory }: AppProps) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pageOverride, setPageOverride] = useState<PageResource | null>(null);
  const [pageActionError, setPageActionError] = useState<Error | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("search");
  const [movePageId, setMovePageId] = useState<string | null>(null);
  const me = useApiQuery((signal) => api.getMe(signal), [api]);
  const tree = useApiQuery((signal) => api.getTree(signal), [api]);
  const favorites = useApiQuery((signal) => api.getFavoritePages(signal), [api]);
  const refetchTree = tree.refetch;
  const refetchFavorites = favorites.refetch;
  const effectiveSelectedPageId = selectedPageId ?? tree.data?.[0]?.id ?? null;
  const page = useApiQuery(
    (signal) => effectiveSelectedPageId
      ? api.getPage(effectiveSelectedPageId, signal)
      : Promise.reject(new Error("ページが選択されていません。")),
    [api, effectiveSelectedPageId],
    Boolean(effectiveSelectedPageId),
  );
  const queriedPage = page.status === "success" && page.data.page.id === effectiveSelectedPageId ? page.data : undefined;
  const visiblePage = pageOverride?.page.id === effectiveSelectedPageId ? pageOverride : queriedPage;
  const visiblePageId = visiblePage?.page.id;
  const isFavorite = visiblePage !== undefined && Boolean(favorites.data?.some((item) => item.id === visiblePage.page.id));

  useEffect(() => {
    if (visiblePageId === undefined) return;
    const controller = new AbortController();
    void api.recordPageView(visiblePageId, controller.signal).catch(() => undefined);
    return () => { controller.abort(); };
  }, [api, visiblePageId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDrawerMode("search");
        setDrawerOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>("#workspace-search")?.focus());
      }
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
        if (window.matchMedia("(max-width: 960px)").matches) setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => {
      document.removeEventListener("keydown", handleShortcut);
    };
  }, []);

  const createPage = useCallback(async () => {
    setPageActionError(null);
    try {
      const resource = await api.createPage({ title: "無題のページ", parentId: effectiveSelectedPageId });
      refetchTree();
      setSelectedPageId(resource.page.id);
      setMobileSidebarOpen(false);
    } catch (error) {
      setPageActionError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, effectiveSelectedPageId, refetchTree]);

  const selectPage = useCallback((id: string) => {
    setPageActionError(null);
    setPageOverride(null);
    setSelectedPageId(id);
    setMobileSidebarOpen(false);
  }, []);

  const pageSaved = useCallback((updated: PageResource) => {
    if (visiblePage?.page.title !== updated.page.title) refetchTree();
    setPageOverride(updated);
  }, [refetchTree, visiblePage?.page.title]);

  const pageMoved = useCallback((updated: PageResource) => {
    setPageOverride(updated);
    refetchTree();
  }, [refetchTree]);

  const moveTreePage = useCallback(async (pageId: string, parentId: string | null) => {
    setPageActionError(null);
    try {
      const updated = await api.movePage(pageId, { parentId });
      if (pageId === effectiveSelectedPageId) setPageOverride(updated);
      refetchTree();
    } catch (error) {
      setPageActionError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, effectiveSelectedPageId, refetchTree]);

  const requestMove = useCallback((pageId: string) => {
    setMovePageId(pageId);
    setDrawerMode("move");
    setDrawerOpen(true);
  }, []);

  const toggleFavorite = useCallback(async () => {
    if (visiblePage === undefined) return;
    setPageActionError(null);
    try {
      await api.setFavorite(visiblePage.page.id, !isFavorite);
      refetchFavorites();
    } catch (error) {
      setPageActionError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [api, isFavorite, refetchFavorites, visiblePage]);

  const tagsChanged = useCallback((tags: PageResource["tags"]) => {
    if (visiblePage === undefined) return;
    setPageOverride({ ...visiblePage, tags });
  }, [visiblePage]);

  const pageRestored = useCallback((restored: PageResource) => {
    refetchTree();
    refetchFavorites();
    setPageOverride(restored);
    setSelectedPageId(restored.page.id);
  }, [refetchFavorites, refetchTree]);

  const pageTrashed = useCallback((pageIds: string[]) => {
    const trashed = new Set(pageIds);
    const nextPage = tree.data ? flattenTree(tree.data).find((candidate) => !trashed.has(candidate.id)) : undefined;
    setPageOverride(null);
    setSelectedPageId(nextPage?.id ?? null);
    setPageActionError(null);
    refetchTree();
    refetchFavorites();
  }, [refetchFavorites, refetchTree, tree.data]);

  return (
    <div className={`workspace-shell ${drawerOpen ? "has-drawer" : ""}`}>
      <a className="skip-link" href="#page-content">本文へ移動</a>

      {mobileSidebarOpen && <button aria-label="サイドバーを閉じる" className="scrim" onClick={() => { setMobileSidebarOpen(false); }} type="button" />}
      <aside aria-label="Wikiナビゲーション" className={`sidebar ${mobileSidebarOpen ? "is-open" : ""}`}>
        <div className="workspace-identity">
          <div className="workspace-monogram" aria-hidden="true">N</div>
          <div>
            <strong>{me.data?.workspace.name ?? "Nago Wiki"}</strong>
            <span>{me.data?.user.displayName ?? "Private workspace"}</span>
          </div>
          <button aria-label="アカウント連携を開く" className="icon-button" onClick={() => { setDrawerMode("account"); setDrawerOpen(true); }} type="button"><Icon name="more" /></button>
        </div>

        <button className="quick-search" onClick={() => { setDrawerMode("search"); setDrawerOpen(true); }} type="button">
          <Icon name="search" />
          <span>Wikiを検索</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav aria-label="知識コレクション" className="sidebar-collections">
          <button onClick={() => { setDrawerMode("recent"); setDrawerOpen(true); }} type="button"><Icon name="clock" /><span>最近見たページ</span></button>
          <button onClick={() => { setDrawerMode("favorites"); setDrawerOpen(true); }} type="button"><Icon name="star" /><span>お気に入り</span></button>
          <button onClick={() => { setDrawerMode("trash"); setDrawerOpen(true); }} type="button"><Icon name="trash" /><span>ゴミ箱</span></button>
        </nav>

        <div className="sidebar-section-heading">
          <span>ページ</span>
          <button aria-label="新しいページ" className="icon-button" onClick={() => void createPage()} type="button"><Icon name="plus" /></button>
        </div>
        <nav className="tree-scroll">
          {tree.status === "loading" && <div className="tree-skeleton" aria-label="ページを読み込み中"><i /><i /><i /></div>}
          {tree.status === "error" && <ErrorNotice error={tree.error} retry={tree.refetch} />}
          {tree.data && <PageTree activeId={effectiveSelectedPageId} nodes={tree.data} onMove={(id, parentId) => { void moveTreePage(id, parentId); }} onRequestMove={requestMove} onSelect={selectPage} />}
        </nav>

        <div className="sidebar-footer">
          <span className={`presence-dot ${me.data?.budget.state === "exhausted" ? "is-offline" : ""}`} />
          <span>{me.data?.budget.state === "exhausted" ? "AI予算上限" : "すべての変更を同期中"}</span>
          {me.data && <small>{me.data.budget.usedPercent}%</small>}
        </div>
      </aside>

      <main className="page-column" id="page-content">
        <header className="page-topbar">
          <button aria-label="サイドバーを開く" className="icon-button mobile-only" onClick={() => { setMobileSidebarOpen(true); }} type="button"><Icon name="menu" /></button>
          <div className="breadcrumbs" aria-label="パンくずリスト">
            <span>Nago Wiki</span><Icon name="chevron" /><strong>{visiblePage?.page.title ?? "読み込み中…"}</strong>
          </div>
          <div className="topbar-actions">
            {visiblePage && <button aria-label={isFavorite ? "お気に入りから外す" : "お気に入りに追加"} aria-pressed={isFavorite} className={`icon-button favorite-button ${isFavorite ? "is-active" : ""}`} onClick={() => { void toggleFavorite(); }} type="button"><Icon name="star" /></button>}
            <button className="button button-quiet" onClick={() => { setDrawerMode("import"); setDrawerOpen(true); }} type="button"><Icon name="book" /> 取り込む</button>
            <button className="button button-quiet" onClick={() => { setDrawerMode("ai"); setDrawerOpen(true); }} type="button"><Icon name="spark" /> AIに質問</button>
            <button aria-label="ページメニュー" className="icon-button" type="button"><Icon name="more" /></button>
          </div>
        </header>

        <section className="editor-stage">
          {pageActionError && <div className="inline-warning is-error page-action-error" role="alert">{pageActionError.message}<button onClick={() => { setPageActionError(null); }} type="button">閉じる</button></div>}
          {!visiblePage && page.status !== "error" && <div className="page-skeleton" aria-label="ページを読み込み中"><i /><i /><i /><i /></div>}
          {page.status === "error" && <ErrorNotice error={page.error} retry={page.refetch} />}
          {visiblePage && (
            <KnowledgeEditor
              api={api}
              key={visiblePage.page.id}
              onOpenBacklinks={() => { setDrawerMode("backlinks"); setDrawerOpen(true); }}
              onOpenComments={() => { setDrawerMode("comments"); setDrawerOpen(true); }}
              onOpenTags={() => { setDrawerMode("tags"); setDrawerOpen(true); }}
              onOpenVersions={() => { setDrawerMode("versions"); setDrawerOpen(true); }}
              onMoved={pageMoved}
              onPageCreated={() => { refetchTree(); }}
              onRequestMove={() => { requestMove(visiblePage.page.id); }}
              onSaved={pageSaved}
              onTrashed={pageTrashed}
              realtimeFactory={realtimeFactory}
              resource={visiblePage}
            />
          )}
        </section>
      </main>

      {drawerOpen && <button aria-label="パネルを閉じる" className="drawer-scrim" onClick={() => { setDrawerOpen(false); }} type="button" />}
      {drawerOpen && <aside aria-label="検索とAI" className="utility-drawer is-open">
        <div className="drawer-header">
          <button className="drawer-home" onClick={() => { setDrawerMode("search"); }} type="button"><Icon name={drawerMode === "ai" ? "spark" : drawerMode === "search" ? "search" : "chevron"} />{drawerMode === "search" || drawerMode === "ai" ? "Nago knowledge" : "検索とAIへ戻る"}</button>
          <button aria-label="パネルを閉じる" className="icon-button" onClick={() => { setDrawerOpen(false); }} type="button"><Icon name="close" /></button>
        </div>
        <div className="drawer-scroll">
          {(drawerMode === "search" || drawerMode === "ai") && <SearchDrawer api={api} mode={drawerMode} onModeChange={setDrawerMode} onSelectPage={selectPage} />}
          {(drawerMode === "comments" || drawerMode === "versions") && visiblePage && (
            <ActivityDrawer api={api} baseRevision={visiblePage.page.revision} key={`${drawerMode}-${visiblePage.page.id}`} mode={drawerMode} onRestored={() => { setPageOverride(null); page.refetch(); }} pageId={visiblePage.page.id} />
          )}
          {drawerMode === "import" && <ImportDrawer api={api} onApplied={(pageId) => { tree.refetch(); selectPage(pageId); setDrawerOpen(false); }} parentPageId={effectiveSelectedPageId} />}
          {drawerMode === "account" && <AccountLinkDrawer api={api} />}
          {isKnowledgeOrganizerMode(drawerMode) && (
            <KnowledgeOrganizerDrawer
              api={api}
              key={`${drawerMode}-${drawerMode === "move" ? movePageId ?? "none" : visiblePage?.page.id ?? "none"}`}
              mode={drawerMode}
              onMoved={(updated) => { pageMoved(updated); setDrawerOpen(false); }}
              onRestored={pageRestored}
              onSelectPage={selectPage}
              onTagsChanged={tagsChanged}
              pageId={drawerMode === "move" ? movePageId : visiblePage?.page.id ?? null}
              pageTags={visiblePage?.tags ?? []}
              tree={tree.data ?? []}
            />
          )}
        </div>
      </aside>}
    </div>
  );
}
