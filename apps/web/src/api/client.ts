import type {
  AnswerResponse,
  AccountLinkCode,
  ApiErrorBody,
  ApplyImportInput,
  BacklinkPage,
  CreatePageInput,
  ImportJob,
  ImportRequest,
  FavoritePageItem,
  MeResponse,
  MovePageInput,
  PageComment,
  PageResource,
  PageTreeNode,
  PageVersion,
  RecentPageItem,
  SearchRequest,
  SearchResponse,
  UpdatePageInput,
  TrashedPageItem,
  WikiApi,
  WikiTag,
  BotProvider,
} from "./types";

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export class RevisionConflictFailure extends ApiFailure {
  constructor(
    message: string,
    requestId: string,
    public readonly latest?: PageResource,
    details?: unknown,
  ) {
    super(409, "REVISION_CONFLICT", message, requestId, details);
    this.name = "RevisionConflictFailure";
  }
}

function isApiError(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(error && typeof error === "object" && "code" in error && "message" in error);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: "INVALID_RESPONSE", message: text, requestId: response.headers.get("cf-ray") ?? "unknown" } };
  }
}

export class HttpWikiApi implements WikiApi {
  constructor(private readonly baseUrl = "/api/v1") {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, credentials: "same-origin" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiFailure(0, "NETWORK_ERROR", "サーバーへ接続できませんでした。", "client", error);
    }

    const body = await readBody(response);
    if (!response.ok) {
      const payload = isApiError(body)
        ? body.error
        : { code: "HTTP_ERROR", message: `Request failed (${String(response.status)})`, requestId: response.headers.get("cf-ray") ?? "unknown" };
      const latest = payload.details && typeof payload.details === "object" && "latest" in payload.details
        ? (payload.details as { latest?: PageResource }).latest
        : undefined;
      if (response.status === 409 && payload.code === "REVISION_CONFLICT") {
        throw new RevisionConflictFailure(payload.message, payload.requestId, latest, payload.details);
      }
      throw new ApiFailure(response.status, payload.code, payload.message, payload.requestId, payload.details);
    }
    return body as T;
  }

  getMe(signal?: AbortSignal) {
    return this.request<MeResponse>("/me", { signal: signal ?? null });
  }

  async getTree(signal?: AbortSignal) {
    const response = await this.request<{ pages: PageTreeNode[] }>("/tree", { signal: signal ?? null });
    return response.pages;
  }

  getPage(id: string, signal?: AbortSignal) {
    return this.request<PageResource>(`/pages/${encodeURIComponent(id)}`, { signal: signal ?? null });
  }

  createPage(input: CreatePageInput, signal?: AbortSignal) {
    return this.request<PageResource>("/pages", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      signal: signal ?? null,
    });
  }

  updatePage(id: string, input: UpdatePageInput, signal?: AbortSignal) {
    return this.request<PageResource>(`/pages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal: signal ?? null,
    });
  }

  movePage(id: string, input: MovePageInput, signal?: AbortSignal) {
    return this.request<PageResource>(`/pages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: signal ?? null,
    });
  }

  trashPage(id: string, signal?: AbortSignal) {
    return this.request<{ status: "trashed"; pageIds: string[] }>(`/pages/${encodeURIComponent(id)}`, { method: "DELETE", signal: signal ?? null });
  }

  restorePage(id: string, signal?: AbortSignal) {
    return this.request<PageResource>(`/pages/${encodeURIComponent(id)}/restore`, { method: "POST", signal: signal ?? null });
  }

  async getRecentPages(signal?: AbortSignal) {
    const response = await this.request<{ pages: RecentPageItem[] }>("/recent", { signal: signal ?? null });
    return response.pages;
  }

  async getFavoritePages(signal?: AbortSignal) {
    const response = await this.request<{ pages: FavoritePageItem[] }>("/favorites", { signal: signal ?? null });
    return response.pages;
  }

  async getTrashedPages(signal?: AbortSignal) {
    const response = await this.request<{ pages: TrashedPageItem[] }>("/trash", { signal: signal ?? null });
    return response.pages;
  }

  async recordPageView(id: string, signal?: AbortSignal) {
    await this.request<undefined>(`/pages/${encodeURIComponent(id)}/view`, { method: "POST", signal: signal ?? null });
  }

  async setFavorite(id: string, favorite: boolean, signal?: AbortSignal) {
    const response = await this.request<{ favorite: boolean }>(`/pages/${encodeURIComponent(id)}/favorite`, {
      method: favorite ? "PUT" : "DELETE",
      signal: signal ?? null,
    });
    return response.favorite;
  }

  async replacePageTags(id: string, names: string[], signal?: AbortSignal) {
    const response = await this.request<{ tags: WikiTag[] }>(`/pages/${encodeURIComponent(id)}/tags`, {
      method: "PUT",
      body: JSON.stringify({ names }),
      signal: signal ?? null,
    });
    return response.tags;
  }

  async getBacklinks(id: string, signal?: AbortSignal) {
    const response = await this.request<{ pages: BacklinkPage[] }>(`/pages/${encodeURIComponent(id)}/backlinks`, { signal: signal ?? null });
    return response.pages;
  }

  async getComments(pageId: string, signal?: AbortSignal) {
    const response = await this.request<{ comments: PageComment[] }>(`/pages/${encodeURIComponent(pageId)}/comments`, { signal: signal ?? null });
    return response.comments;
  }

  createComment(pageId: string, bodyMd: string, signal?: AbortSignal) {
    return this.request<PageComment>(`/pages/${encodeURIComponent(pageId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ bodyMd, mentionedUserIds: [] }),
      signal: signal ?? null,
    });
  }

  async getVersions(pageId: string, signal?: AbortSignal) {
    const response = await this.request<{ versions: PageVersion[] }>(`/pages/${encodeURIComponent(pageId)}/versions`, { signal: signal ?? null });
    return response.versions;
  }

  restoreVersion(pageId: string, versionId: string, baseRevision: number, signal?: AbortSignal) {
    return this.request<PageResource>(`/pages/${encodeURIComponent(pageId)}/versions/${encodeURIComponent(versionId)}/restore`, {
      method: "POST",
      body: JSON.stringify({ baseRevision }),
      signal: signal ?? null,
    });
  }

  search(input: SearchRequest, signal?: AbortSignal) {
    return this.request<SearchResponse>("/search", { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
  }

  answer(query: string, knowledgeMode: "wiki_only" | "wiki_plus_general", signal?: AbortSignal) {
    return this.request<AnswerResponse>("/answer", {
      method: "POST",
      body: JSON.stringify({ query, knowledgeMode }),
      signal: signal ?? null,
    });
  }

  createImport(input: ImportRequest, signal?: AbortSignal) {
    return this.request<ImportJob>("/imports", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      signal: signal ?? null,
    });
  }

  getImport(id: string, signal?: AbortSignal) {
    return this.request<ImportJob>(`/imports/${encodeURIComponent(id)}`, { signal: signal ?? null });
  }

  applyImport(id: string, input: ApplyImportInput, signal?: AbortSignal) {
    return this.request<PageResource>(`/imports/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: signal ?? null,
    });
  }

  createAccountLink(provider: BotProvider, signal?: AbortSignal) {
    return this.request<AccountLinkCode>("/account-links", {
      method: "POST",
      body: JSON.stringify({ provider }),
      signal: signal ?? null,
    });
  }
}
