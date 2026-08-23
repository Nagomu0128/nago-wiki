import { RevisionConflictFailure } from "./client";
import type {
  AnswerResponse,
  AccountLinkCode,
  ApplyImportInput,
  CreatePageInput,
  ImportJob,
  ImportRequest,
  GooglePickerConfiguration,
  MeResponse,
  MovePageInput,
  PageComment,
  PageResource,
  PageTreeNode,
  PageVersion,
  SearchRequest,
  UpdatePageInput,
  WikiApi,
  WikiPage,
  BotProvider,
} from "./types";

const ids = {
  workspace: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  welcome: "30000000-0000-4000-8000-000000000001",
  strategy: "30000000-0000-4000-8000-000000000002",
  architecture: "30000000-0000-4000-8000-000000000003",
  meeting: "30000000-0000-4000-8000-000000000004",
};

const now = "2026-08-18T02:00:00.000Z";

function hash(value: string) {
  const seed = Array.from(value).reduce((result, character) => (result * 31 + (character.codePointAt(0) ?? 0)) >>> 0, 0).toString(16);
  return seed.padStart(64, "0").slice(-64);
}

function page(input: Pick<WikiPage, "id" | "parentId" | "slug" | "title" | "bodyMd">): PageResource {
  return {
    page: {
      ...input,
      workspaceId: ids.workspace,
      revision: 1,
      contentHash: hash(input.bodyMd),
      accessMode: "workspace",
      status: "active",
      createdBy: ids.user,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
    },
    permission: "owner",
    tags: input.id === ids.architecture
      ? [{ id: "40000000-0000-4000-8000-000000000001", name: "architecture" }]
      : [],
  };
}

const initialPages = [
  page({
    id: ids.welcome,
    parentId: null,
    slug: "start-here",
    title: "はじめに",
    bodyMd: "# Nago Wikiへようこそ\n\nここは、考えを静かに育てるためのprivate knowledge workspaceです。\n\n## 今日から始めること\n\n- 思いついたことをInboxへ書く\n- `[[ページ名]]` で知識をつなぐ\n- 検索とAI回答では必ず根拠を確認する\n",
  }),
  page({
    id: ids.strategy,
    parentId: null,
    slug: "product",
    title: "プロダクト",
    bodyMd: "# プロダクト\n\nプロダクトに関する意思決定と学びをまとめます。",
  }),
  page({
    id: ids.architecture,
    parentId: ids.strategy,
    slug: "architecture",
    title: "Nago Wiki アーキテクチャ",
    bodyMd: "# Nago Wiki アーキテクチャ\n\nCloudflare Workers、D1、R2、Durable Objectsを中心に構成します。\n\n## 原則\n\n1. Markdownを正本にする\n2. AI Searchの候補はD1 ACLで再認可する\n3. 編集中の状態はページ単位のDurable Objectが直列化する\n",
  }),
  page({
    id: ids.meeting,
    parentId: null,
    slug: "meetings",
    title: "ミーティングノート",
    bodyMd: "# ミーティングノート\n\n- 次回: Importの品質確認\n- 決定: Wiki由来の回答にはcitationを必須にする",
  }),
];

function abortableDelay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, 35);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FixtureWikiApi implements WikiApi {
  private readonly pages = new Map(initialPages.map((resource) => [resource.page.id, clone(resource)]));
  private readonly comments = new Map<string, PageComment[]>();
  private readonly imports = new Map<string, ImportJob>();

  async getMe(signal?: AbortSignal): Promise<MeResponse> {
    await abortableDelay(signal);
    return {
      user: { id: ids.user, displayName: "Nagomu", email: "nagomu@example.com", role: "owner" },
      workspace: { id: ids.workspace, name: "Nago Wiki" },
      features: { aiAnswer: true, googleImport: true, realtime: true },
      budget: { state: "normal", usedPercent: 18 },
    };
  }

  async getTree(signal?: AbortSignal) {
    await abortableDelay(signal);
    const active = [...this.pages.values()].filter(({ page }) => page.status === "active");
    const build = (parentId: string | null): PageTreeNode[] => active
      .filter(({ page }) => page.parentId === parentId)
      .map(({ page }) => ({
        id: page.id,
        parentId: page.parentId,
        slug: page.slug,
        title: page.title,
        accessMode: page.accessMode,
        updatedAt: page.updatedAt,
        children: build(page.id),
      }));
    return build(null);
  }

  async getPage(id: string, signal?: AbortSignal) {
    await abortableDelay(signal);
    const value = this.pages.get(id);
    if (!value) throw new Error("ページが見つかりませんでした。");
    return clone(value);
  }

  async createPage(input: CreatePageInput, signal?: AbortSignal) {
    await abortableDelay(signal);
    const id = crypto.randomUUID();
    const resource = page({
      id,
      parentId: input.parentId ?? null,
      slug: input.slug ?? input.title.toLowerCase().replace(/\s+/g, "-"),
      title: input.title,
      bodyMd: input.bodyMd ?? "",
    });
    resource.page.accessMode = input.accessMode ?? "workspace";
    this.pages.set(id, resource);
    return clone(resource);
  }

  async updatePage(id: string, input: UpdatePageInput, signal?: AbortSignal) {
    await abortableDelay(signal);
    const resource = this.pages.get(id);
    if (!resource) throw new Error("ページが見つかりませんでした。");
    if (resource.page.revision !== input.baseRevision) {
      throw new RevisionConflictFailure("別の編集が先に保存されました。", "fixture-conflict", clone(resource));
    }
    resource.page = {
      ...resource.page,
      title: input.title ?? resource.page.title,
      bodyMd: input.bodyMd ?? resource.page.bodyMd,
      revision: resource.page.revision + 1,
      contentHash: hash(input.bodyMd ?? resource.page.bodyMd),
      updatedAt: new Date().toISOString(),
    };
    return clone(resource);
  }

  async movePage(id: string, input: MovePageInput, signal?: AbortSignal) {
    await abortableDelay(signal);
    const resource = this.pages.get(id);
    if (!resource) throw new Error("ページが見つかりませんでした。");
    resource.page.parentId = input.parentId;
    resource.page.title = input.title ?? resource.page.title;
    resource.page.slug = input.slug ?? resource.page.slug;
    return clone(resource);
  }

  async trashPage(id: string, signal?: AbortSignal): Promise<{ status: "trashed"; pageIds: string[] }> {
    await abortableDelay(signal);
    const trashed: string[] = [];
    const visit = (pageId: string) => {
      const resource = this.pages.get(pageId);
      if (!resource) return;
      resource.page.status = "trashed";
      resource.page.trashedAt = new Date().toISOString();
      trashed.push(pageId);
      [...this.pages.values()].filter(({ page }) => page.parentId === pageId).forEach(({ page }) => {
        visit(page.id);
      });
    };
    visit(id);
    return { status: "trashed", pageIds: trashed };
  }

  async restorePage(id: string, signal?: AbortSignal) {
    await abortableDelay(signal);
    const resource = this.pages.get(id);
    if (!resource) throw new Error("ページが見つかりませんでした。");
    resource.page.status = "active";
    resource.page.trashedAt = null;
    return clone(resource);
  }

  async getComments(pageId: string, signal?: AbortSignal): Promise<PageComment[]> {
    await abortableDelay(signal);
    const initial: PageComment[] = [{
      id: "50000000-0000-4000-8000-000000000001",
      pageId,
      authorId: ids.user,
      authorName: "Nagomu",
      bodyMd: "このページは、判断の理由まで残していきたいです。",
      status: "open",
      mentionedUserIds: [],
      createdAt: now,
      updatedAt: now,
    }];
    return clone(this.comments.get(pageId) ?? initial);
  }

  async createComment(pageId: string, bodyMd: string, signal?: AbortSignal) {
    await abortableDelay(signal);
    const comment: PageComment = {
      id: crypto.randomUUID(),
      pageId,
      authorId: ids.user,
      authorName: "Nagomu",
      bodyMd,
      status: "open",
      mentionedUserIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.comments.set(pageId, [...(this.comments.get(pageId) ?? []), comment]);
    return clone(comment);
  }

  async getVersions(pageId: string, signal?: AbortSignal) {
    await abortableDelay(signal);
    const resource = this.pages.get(pageId);
    if (!resource) return [];
    const versions: PageVersion[] = [resource.page.revision, Math.max(1, resource.page.revision - 1)].map((revision, index) => ({
      id: `60000000-0000-4000-8000-00000000000${String(index + 1)}`,
      pageId,
      revision,
      contentHash: resource.page.contentHash,
      authorId: ids.user,
      reason: index === 0 ? "edit" : "create",
      storageStatus: "ready",
      createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
    }));
    return versions;
  }

  async restoreVersion(pageId: string, _versionId: string, baseRevision: number, signal?: AbortSignal) {
    const current = await this.getPage(pageId, signal);
    return this.updatePage(pageId, { baseRevision, bodyMd: `${current.page.bodyMd}\n\n> 過去版から復元しました。` }, signal);
  }

  async search(input: SearchRequest, signal?: AbortSignal) {
    await abortableDelay(signal);
    const query = input.query.toLocaleLowerCase("ja");
    const hits = [...this.pages.values()]
      .filter(({ page }) => page.status === "active" && `${page.title}\n${page.bodyMd}`.toLocaleLowerCase("ja").includes(query))
      .slice(0, input.limit ?? 20)
      .map(({ page: item }) => ({
        pageId: item.id,
        title: item.title,
        path: `/${item.slug}`,
        url: `/pages/${item.id}`,
        snippet: item.bodyMd.replace(/^#+\s+/gm, "").slice(0, 150),
        score: item.title.toLocaleLowerCase("ja").includes(query) ? 0.96 : 0.81,
        source: item.title.toLocaleLowerCase("ja").includes(query) ? "title" as const : "semantic" as const,
        contentHash: item.contentHash,
      }));
    return { hits, cursor: null };
  }

  async answer(query: string, _knowledgeMode: "wiki_only" | "wiki_plus_general", signal?: AbortSignal): Promise<AnswerResponse> {
    const result = await this.search({ query: query.includes("Cloudflare") ? "Cloudflare" : "Markdown" }, signal);
    const hit = result.hits[0];
    if (!hit) return { state: "insufficient", answerMarkdown: "Wiki内に回答できる根拠が見つかりませんでした。", citations: [], requestId: "fixture-answer" };
    return {
      state: "wiki",
      answerMarkdown: "Nago Wikiは、**Markdownを正本**としてCloudflare上に知識を保存します。回答に使う候補は、現行の権限で再確認してから利用します。",
      citations: [{ id: "citation-1", ...hit }],
      requestId: "fixture-answer",
    };
  }

  async createImport(input: ImportRequest, signal?: AbortSignal) {
    await abortableDelay(signal);
    const job: ImportJob = {
      id: crypto.randomUUID(),
      sourceType: input.sourceType,
      sourceLabel: input.documentId || "Google Document: Product Notes",
      status: "preview_ready",
      previewMarkdown: "# Imported knowledge\n\n## 決定事項\n\nWikiへ移行する文章のプレビューです。\n\n- 見出し、箇条書き、表を保持\n- 変換不能要素は警告として残す",
      currentMarkdown: "# Imported knowledge\n\n以前のWiki本文です。",
      warnings: ["Google Docsのdrawing 1件をplaceholderへ変換しました。"],
      suggestedTitle: "Imported knowledge",
      suggestedTags: ["import", "inbox"],
      createdAt: new Date().toISOString(),
    };
    this.imports.set(job.id, job);
    return clone(job);
  }

  async getGoogleImportAuthorization(
    returnTo: string,
    signal?: AbortSignal,
  ): Promise<{ authorizationUrl: string }> {
    await abortableDelay(signal);
    return { authorizationUrl: returnTo };
  }

  async getGoogleImportPickerConfiguration(
    signal?: AbortSignal,
  ): Promise<GooglePickerConfiguration> {
    await abortableDelay(signal);
    return {
      accessToken: "fixture-access-token",
      developerKey: "fixture-developer-key",
      appId: "1234567890",
    };
  }

  async getImport(id: string, signal?: AbortSignal) {
    await abortableDelay(signal);
    const job = this.imports.get(id);
    if (!job) throw new Error("Import jobが見つかりませんでした。");
    return clone(job);
  }

  async applyImport(id: string, input: ApplyImportInput, signal?: AbortSignal) {
    const job = await this.getImport(id, signal);
    job.status = "applied";
    this.imports.set(id, job);
    return this.createPage({ parentId: input.parentId, title: input.title, bodyMd: job.previewMarkdown ?? "" }, signal);
  }

  async createAccountLink(_provider: BotProvider, signal?: AbortSignal): Promise<AccountLinkCode> {
    await abortableDelay(signal);
    return {
      code: "fixture-link-code",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }
}
