import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiFailure, createWikiApi, useApiQuery, type PageTreeNode, type WikiApi } from "./api";
import { KnowledgeEditor } from "./editor";
import { NativeYjsRealtimeProviderFactory, type RealtimeProviderFactory } from "./realtime";

const defaultApi = createWikiApi();
const defaultRealtimeFactory = new NativeYjsRealtimeProviderFactory();

type DrawerMode = "search" | "ai";

interface AppProps {
  api?: WikiApi;
  realtimeFactory?: RealtimeProviderFactory;
}

function flattenTree(nodes: PageTreeNode[]): PageTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function Icon({ name }: { name: "book" | "chevron" | "plus" | "search" | "spark" | "menu" | "more" | "close" | "lock" }) {
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
}

function PageTree({ nodes, activeId, onSelect }: TreeProps) {
  const items = useMemo(() => flattenTree(nodes), [nodes]);
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
    <li key={node.id} role="none">
      <button
        aria-current={node.id === activeId ? "page" : undefined}
        aria-level={level}
        className="tree-item"
        onClick={() => { onSelect(node.id); }}
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
      {node.children.length > 0 && <ul role="group">{renderNodes(node.children, level + 1)}</ul>}
    </li>
  ));

  return <ul aria-label="ページ" className="page-tree" role="tree">{renderNodes(nodes, 1)}</ul>;
}

export function App({ api = defaultApi, realtimeFactory = defaultRealtimeFactory }: AppProps) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("search");
  const me = useApiQuery((signal) => api.getMe(signal), [api]);
  const tree = useApiQuery((signal) => api.getTree(signal), [api]);
  const effectiveSelectedPageId = selectedPageId ?? tree.data?.[0]?.id ?? null;
  const page = useApiQuery(
    (signal) => effectiveSelectedPageId
      ? api.getPage(effectiveSelectedPageId, signal)
      : Promise.reject(new Error("ページが選択されていません。")),
    [api, effectiveSelectedPageId],
    Boolean(effectiveSelectedPageId),
  );

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
    const resource = await api.createPage({ title: "無題のページ", parentId: effectiveSelectedPageId });
    tree.refetch();
    setSelectedPageId(resource.page.id);
    setMobileSidebarOpen(false);
  }, [api, effectiveSelectedPageId, tree]);

  const selectPage = useCallback((id: string) => {
    setSelectedPageId(id);
    setMobileSidebarOpen(false);
  }, []);

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
          <button aria-label="ワークスペースメニュー" className="icon-button" type="button"><Icon name="more" /></button>
        </div>

        <button className="quick-search" onClick={() => { setDrawerMode("search"); setDrawerOpen(true); }} type="button">
          <Icon name="search" />
          <span>Wikiを検索</span>
          <kbd>⌘ K</kbd>
        </button>

        <div className="sidebar-section-heading">
          <span>ページ</span>
          <button aria-label="新しいページ" className="icon-button" onClick={() => void createPage()} type="button"><Icon name="plus" /></button>
        </div>
        <nav className="tree-scroll">
          {tree.status === "loading" && <div className="tree-skeleton" aria-label="ページを読み込み中"><i /><i /><i /></div>}
          {tree.status === "error" && <ErrorNotice error={tree.error} retry={tree.refetch} />}
          {tree.data && <PageTree activeId={effectiveSelectedPageId} nodes={tree.data} onSelect={selectPage} />}
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
            <span>Nago Wiki</span><Icon name="chevron" /><strong>{page.data?.page.title ?? "読み込み中…"}</strong>
          </div>
          <div className="topbar-actions">
            <button className="button button-quiet" onClick={() => { setDrawerMode("ai"); setDrawerOpen(true); }} type="button"><Icon name="spark" /> AIに質問</button>
            <button aria-label="ページメニュー" className="icon-button" type="button"><Icon name="more" /></button>
          </div>
        </header>

        <section className="editor-stage">
          {page.status === "loading" && <div className="page-skeleton" aria-label="ページを読み込み中"><i /><i /><i /><i /></div>}
          {page.status === "error" && <ErrorNotice error={page.error} retry={page.refetch} />}
          {page.data && (
            <KnowledgeEditor
              api={api}
              key={page.data.page.id}
              onOpenComments={() => { setDrawerOpen(true); }}
              onOpenVersions={() => { setDrawerOpen(true); }}
              realtimeFactory={realtimeFactory}
              resource={page.data}
            />
          )}
        </section>
      </main>

      {drawerOpen && <button aria-label="パネルを閉じる" className="drawer-scrim" onClick={() => { setDrawerOpen(false); }} type="button" />}
      <aside aria-label="検索とAI" className={`utility-drawer ${drawerOpen ? "is-open" : ""}`}>
        <div className="drawer-header">
          <div className="segmented-control" role="tablist" aria-label="ツール">
            <button aria-selected={drawerMode === "search"} onClick={() => { setDrawerMode("search"); }} role="tab" type="button"><Icon name="search" /> 検索</button>
            <button aria-selected={drawerMode === "ai"} onClick={() => { setDrawerMode("ai"); }} role="tab" type="button"><Icon name="spark" /> AI回答</button>
          </div>
          <button aria-label="パネルを閉じる" className="icon-button" onClick={() => { setDrawerOpen(false); }} type="button"><Icon name="close" /></button>
        </div>
        <div className="drawer-placeholder">
          <span className="feature-orb"><Icon name={drawerMode === "search" ? "search" : "spark"} /></span>
          <h2>{drawerMode === "search" ? "すべての知識から探す" : "Wikiを根拠に回答する"}</h2>
          <p>{drawerMode === "search" ? "キーワードと意味の両方から、閲覧できるページを横断検索します。" : "回答と引用元を分けて表示し、一般知識を使った箇所も明示します。"}</p>
          <label className="search-field" htmlFor="workspace-search"><Icon name="search" /><input id="workspace-search" placeholder={drawerMode === "search" ? "検索語を入力…" : "Wikiに質問…"} /></label>
        </div>
      </aside>
    </div>
  );
}
