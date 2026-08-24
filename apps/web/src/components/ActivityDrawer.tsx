import { useState } from "react";
import { useApiMutation, useApiQuery, type WikiApi } from "../api";

export type ActivityMode = "comments" | "versions";

interface ActivityDrawerProps {
  api: WikiApi;
  mode: ActivityMode;
  pageId: string;
  baseRevision: number;
  onRestored: () => void;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ActivityDrawer({ api, mode, pageId, baseRevision, onRestored }: ActivityDrawerProps) {
  const [commentBody, setCommentBody] = useState("");
  const [restoreCandidate, setRestoreCandidate] = useState<string | null>(null);
  const comments = useApiQuery((signal) => api.getComments(pageId, signal), [api, pageId], mode === "comments");
  const versions = useApiQuery((signal) => api.getVersions(pageId, signal), [api, pageId], mode === "versions");
  const createComment = useApiMutation((body: string, signal) => api.createComment(pageId, body, signal));
  const restoreVersion = useApiMutation((versionId: string, signal) => api.restoreVersion(pageId, versionId, baseRevision, signal));

  const submitComment = async () => {
    const value = commentBody.trim();
    if (!value) return;
    await createComment.mutate(value);
    setCommentBody("");
    comments.refetch();
  };

  const restore = async (versionId: string) => {
    await restoreVersion.mutate(versionId);
    setRestoreCandidate(null);
    onRestored();
  };

  return (
    <div className="activity-panel">
      <div className="drawer-section-title"><span>{mode === "comments" ? "Conversation" : "Page history"}</span><h2>{mode === "comments" ? "コメント" : "変更履歴"}</h2></div>
      {mode === "comments" ? (
        <>
          <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment().catch(() => undefined); }}>
            <textarea aria-label="コメント" onChange={(event) => { setCommentBody(event.target.value); }} placeholder="コメントを追加。@名前 でメンション…" rows={3} value={commentBody} />
            <div><small>Markdownを使用できます</small><button disabled={!commentBody.trim() || createComment.status === "loading"} type="submit">送信</button></div>
          </form>
          {comments.status === "loading" && <div className="drawer-loading" role="status"><i /><span>コメントを読み込み中…</span></div>}
          {comments.status === "error" && <div className="drawer-error" role="alert">{comments.error.message}</div>}
          {createComment.status === "error" && <div className="drawer-error" role="alert">{createComment.error.message}</div>}
          <div className="comment-list">
            {comments.data?.map((comment) => (
              <article key={comment.id}>
                <div className="comment-avatar" aria-hidden="true">{(comment.authorName ?? "U").slice(0, 1)}</div>
                <div><header><strong>{comment.authorName ?? comment.authorId.slice(0, 8)}</strong><time dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time></header><p>{comment.bodyMd}</p></div>
              </article>
            ))}
            {comments.data?.length === 0 && <div className="empty-state"><strong>コメントはまだありません</strong><span>判断の理由や確認事項を残せます。</span></div>}
          </div>
        </>
      ) : (
        <>
          {versions.status === "loading" && <div className="drawer-loading" role="status"><i /><span>履歴を読み込み中…</span></div>}
          {versions.status === "error" && <div className="drawer-error" role="alert">{versions.error.message}</div>}
          {restoreVersion.status === "error" && <div className="drawer-error" role="alert">{restoreVersion.error.message}</div>}
          <ol className="version-list">
            {versions.data?.map((version, index) => (
              <li key={version.id}>
                <i />
                <div><strong>Revision {version.revision}</strong><span>{version.reason === "create" ? "ページを作成" : version.reason === "restore" ? "過去版から復元" : "内容を更新"}</span><time dateTime={version.createdAt}>{formatTime(version.createdAt)}</time></div>
                {index > 0 && <button onClick={() => { setRestoreCandidate(version.id); }} type="button">復元</button>}
              </li>
            ))}
          </ol>
          {restoreCandidate && (
            <div className="restore-confirm" role="alertdialog" aria-label="過去版を復元">
              <strong>この版を新しいrevisionとして復元しますか？</strong>
              <p>現在の内容は履歴に残り、失われません。</p>
              <div><button onClick={() => { setRestoreCandidate(null); }} type="button">キャンセル</button><button disabled={restoreVersion.status === "loading"} onClick={() => { void restore(restoreCandidate).catch(() => undefined); }} type="button">復元する</button></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
