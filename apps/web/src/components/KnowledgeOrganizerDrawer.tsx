import { useMemo, useState } from "react";

import type {
  PageResource,
  PageNavigationItem,
  PageTreeNode,
  WikiApi,
  WikiTag,
} from "../api";
import { useApiMutation, useApiQuery } from "../api";

export type KnowledgeOrganizerMode =
  | "recent"
  | "favorites"
  | "trash"
  | "tags"
  | "backlinks"
  | "move";

type CollectionEntry = PageNavigationItem & {
  activityAt: string;
  restorable?: boolean;
};

interface KnowledgeOrganizerDrawerProps {
  api: WikiApi;
  mode: KnowledgeOrganizerMode;
  pageId: string | null;
  pageTags: WikiTag[];
  tree: PageTreeNode[];
  onMoved: (resource: PageResource) => void;
  onRestored: (resource: PageResource) => void;
  onSelectPage: (pageId: string) => void;
  onTagsChanged: (tags: WikiTag[]) => void;
}

export function KnowledgeOrganizerDrawer(props: KnowledgeOrganizerDrawerProps) {
  if (props.mode === "tags") return <TagsPanel {...props} />;
  if (props.mode === "backlinks") return <BacklinksPanel {...props} />;
  if (props.mode === "move") return <MovePanel {...props} />;
  return <CollectionPanel {...props} mode={props.mode} />;
}

function CollectionPanel({ api, mode, onRestored, onSelectPage }: KnowledgeOrganizerDrawerProps & {
  mode: "recent" | "favorites" | "trash";
}) {
  const collection = useApiQuery<CollectionEntry[]>(
    async (signal) => {
      if (mode === "recent") {
        return (await api.getRecentPages(signal)).map((page) => ({ ...page, activityAt: page.lastViewedAt }));
      }
      if (mode === "favorites") {
        return (await api.getFavoritePages(signal)).map((page) => ({ ...page, activityAt: page.favoritedAt }));
      }
      return (await api.getTrashedPages(signal)).map((page) => ({ ...page, activityAt: page.trashedAt }));
    },
    [api, mode],
  );
  const [restoreError, setRestoreError] = useState<Error | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const restore = async (page: CollectionEntry) => {
    setRestoreError(null);
    setRestoringId(page.id);
    try {
      const restored = await api.restorePage(page.id);
      collection.refetch();
      onRestored(restored);
    } catch (error) {
      setRestoreError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setRestoringId(null);
    }
  };

  const labels = {
    recent: ["Recent", "最近見たページ", "直近に開いた50件を表示します。"],
    favorites: ["Favorites", "お気に入り", "よく使う知識へすぐ戻れます。"],
    trash: ["Trash", "ゴミ箱", "削除後30日以内のページを復元できます。"],
  } as const;
  const label = labels[mode];

  return (
    <section className="organization-panel">
      <div className="drawer-section-title">
        <span>{label[0]}</span>
        <h2>{label[1]}</h2>
        <p>{label[2]}</p>
      </div>
      {collection.status === "loading" && <DrawerLoading />}
      {collection.status === "error" && <div className="drawer-error" role="alert">{collection.error.message}</div>}
      {restoreError && <div className="drawer-error" role="alert">{restoreError.message}</div>}
      <div className="organization-list">
        {collection.data?.map((page) => (
          <article key={page.id}>
            <button className="organization-page-link" onClick={() => { if (mode !== "trash") onSelectPage(page.id); }} type="button">
              <strong>{page.title}</strong>
              <span>{formatActivityTime(page.activityAt)}</span>
            </button>
            {mode === "trash" && (
              <button
                className="organization-action"
                disabled={page.restorable !== true || restoringId === page.id}
                onClick={() => { void restore(page); }}
                title={page.restorable === true ? "ページと同時に削除された子ページを復元します" : "先に親ページを復元してください"}
                type="button"
              >
                {restoringId === page.id ? "復元中…" : "復元"}
              </button>
            )}
          </article>
        ))}
      </div>
      {collection.status === "success" && collection.data.length === 0 && (
        <div className="empty-state"><strong>ページはありません</strong><span>ここに表示されるページはまだありません。</span></div>
      )}
    </section>
  );
}

function TagsPanel({ api, onTagsChanged, pageId, pageTags }: KnowledgeOrganizerDrawerProps) {
  const [value, setValue] = useState(pageTags.map((tag) => tag.name).join(", "));
  const saveTags = useApiMutation((names: string[], signal) => {
    if (pageId === null) throw new Error("ページを選択してください");
    return api.replacePageTags(pageId, names, signal);
  });
  const names = useMemo(() => parseTagNames(value), [value]);

  const save = async () => {
    const tags = await saveTags.mutate(names);
    onTagsChanged(tags);
  };

  return (
    <section className="organization-panel">
      <div className="drawer-section-title"><span>Tags</span><h2>タグを編集</h2><p>カンマまたは改行で区切って最大50件まで設定できます。</p></div>
      <form className="organization-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label htmlFor="page-tags">タグ</label>
        <textarea id="page-tags" onChange={(event) => { setValue(event.target.value); }} rows={5} value={value} />
        <div className="tag-preview" aria-label="設定するタグ">{names.map((name) => <span key={name}>#{name}</span>)}</div>
        {saveTags.status === "error" && <div className="drawer-error" role="alert">{saveTags.error.message}</div>}
        <button className="button button-primary" disabled={pageId === null || saveTags.status === "loading"} type="submit">タグを保存</button>
      </form>
    </section>
  );
}

function BacklinksPanel({ api, onSelectPage, pageId }: KnowledgeOrganizerDrawerProps) {
  const backlinks = useApiQuery(
    (signal) => pageId === null ? Promise.resolve([]) : api.getBacklinks(pageId, signal),
    [api, pageId],
    pageId !== null,
  );
  return (
    <section className="organization-panel">
      <div className="drawer-section-title"><span>Backlinks</span><h2>このページへのリンク</h2><p>現在のページを参照している、閲覧可能なページだけを表示します。</p></div>
      {backlinks.status === "loading" && <DrawerLoading />}
      {backlinks.status === "error" && <div className="drawer-error" role="alert">{backlinks.error.message}</div>}
      <div className="organization-list">
        {backlinks.data?.map((page) => (
          <article key={page.id}>
            <button className="organization-page-link" onClick={() => { onSelectPage(page.id); }} type="button">
              <strong>{page.title}</strong><span>{page.path}</span>
            </button>
          </article>
        ))}
      </div>
      {backlinks.status === "success" && backlinks.data.length === 0 && <div className="empty-state"><strong>リンク元はありません</strong><span>`[[ページ名]]`で知識同士をつなげられます。</span></div>}
    </section>
  );
}

function MovePanel({ api, onMoved, pageId, tree }: KnowledgeOrganizerDrawerProps) {
  const items = useMemo(() => flattenTree(tree), [tree]);
  const excluded = useMemo(() => pageId === null ? new Set<string>() : subtreeIds(tree, pageId), [pageId, tree]);
  const [parentId, setParentId] = useState<string | null>(null);
  const move = useApiMutation((destination: string | null, signal) => {
    if (pageId === null) throw new Error("ページを選択してください");
    return api.movePage(pageId, { parentId: destination }, signal);
  });
  const submit = async () => {
    const updated = await move.mutate(parentId);
    onMoved(updated);
  };

  return (
    <section className="organization-panel">
      <div className="drawer-section-title"><span>Move</span><h2>ページを移動</h2><p>ドラッグ操作が難しい場合も、移動先を選んで同じ操作を実行できます。</p></div>
      <form className="organization-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="move-parent">移動先</label>
        <select id="move-parent" onChange={(event) => { setParentId(event.target.value || null); }} value={parentId ?? ""}>
          <option value="">トップ階層</option>
          {items.filter((item) => !excluded.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        {move.status === "error" && <div className="drawer-error" role="alert">{move.error.message}</div>}
        <button className="button button-primary" disabled={pageId === null || move.status === "loading"} type="submit">この場所へ移動</button>
      </form>
    </section>
  );
}

function flattenTree(nodes: PageTreeNode[]): PageTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function subtreeIds(nodes: PageTreeNode[], pageId: string): Set<string> {
  const target = flattenTree(nodes).find((page) => page.id === pageId);
  return new Set(target === undefined ? [pageId] : flattenTree([target]).map((page) => page.id));
}

function parseTagNames(value: string): string[] {
  return [...new Set(value.split(/[,\n]/u).map((name) => name.trim()).filter(Boolean))].slice(0, 50);
}

function formatActivityTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function DrawerLoading() {
  return <div className="drawer-loading" role="status"><i /><span>読み込み中…</span></div>;
}
