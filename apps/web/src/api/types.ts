export type WorkspaceRole = "owner" | "editor" | "viewer";
export type PagePermission = WorkspaceRole;
export type PageAccessMode = "workspace" | "restricted";
export type PageStatus = "active" | "trashed";

export interface SessionUser {
  id: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  avatarUrl?: string;
}

export interface MeResponse {
  user: SessionUser;
  workspace: { id: string; name: string };
  features: {
    aiAnswer: boolean;
    googleImport: boolean;
    realtime: boolean;
  };
  budget: {
    state: "normal" | "warning" | "degraded" | "exhausted";
    usedPercent: number;
  };
}

export interface PageTreeNode {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  accessMode: PageAccessMode;
  updatedAt: string;
  children: PageTreeNode[];
}

export interface WikiPage {
  id: string;
  workspaceId: string;
  parentId: string | null;
  slug: string;
  title: string;
  bodyMd: string;
  revision: number;
  contentHash: string;
  accessMode: PageAccessMode;
  status: PageStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}

export interface PageResource {
  page: WikiPage;
  permission: PagePermission;
  tags: { id: string; name: string }[];
}

export interface CreatePageInput {
  parentId?: string | null;
  slug?: string;
  title: string;
  bodyMd?: string;
  accessMode?: PageAccessMode;
}

export interface UpdatePageInput {
  baseRevision: number;
  title?: string;
  bodyMd?: string;
}

export interface MovePageInput {
  parentId: string | null;
  slug?: string;
  title?: string;
}

export interface PageVersion {
  id: string;
  pageId: string;
  revision: number;
  contentHash: string;
  authorId: string;
  reason: "create" | "edit" | "move" | "restore" | "import" | "manual";
  storageStatus: "pending" | "ready" | "failed";
  createdAt: string;
}

export interface PageComment {
  id: string;
  pageId: string;
  authorId: string;
  authorName?: string;
  bodyMd: string;
  status: "open" | "resolved" | "deleted";
  mentionedUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchRequest {
  query: string;
  mode?: SearchMode;
  parentPageId?: string;
  tagIds?: string[];
  limit?: number;
  cursor?: string;
}

export interface SearchHit {
  pageId: string;
  title: string;
  path: string;
  url: string;
  snippet: string;
  score: number;
  source: "title" | "keyword" | "semantic";
  contentHash: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  cursor: string | null;
}

export type AnswerState = "wiki" | "mixed" | "general" | "insufficient";

export interface AnswerResponse {
  state: AnswerState;
  answerMarkdown: string;
  citations: {
    id: string;
    pageId: string;
    title: string;
    path: string;
    url: string;
    snippet: string;
    contentHash: string;
  }[];
  requestId: string;
}

export type ImportSourceType = "google_docs" | "markdown" | "pdf" | "url" | "paste";
export type ImportStatus = "queued" | "running" | "preview_ready" | "applied" | "failed";

export interface ImportRequest {
  sourceType: ImportSourceType;
  sourceUrl?: string;
  documentId?: string;
  filename?: string;
  content?: string;
}

export interface ImportJob {
  id: string;
  sourceType: ImportSourceType;
  sourceLabel: string;
  status: ImportStatus;
  previewMarkdown?: string;
  currentMarkdown?: string;
  warnings: string[];
  suggestedTitle?: string;
  suggestedTags?: string[];
  error?: { code: string; message: string; reauthUrl?: string };
  createdAt: string;
}

export interface ApplyImportInput {
  parentId: string | null;
  title: string;
  acceptedTags: string[];
}

export type BotProvider = "discord" | "line";

export interface AccountLinkCode {
  code: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

export interface WikiApi {
  getMe(signal?: AbortSignal): Promise<MeResponse>;
  getTree(signal?: AbortSignal): Promise<PageTreeNode[]>;
  getPage(id: string, signal?: AbortSignal): Promise<PageResource>;
  createPage(input: CreatePageInput, signal?: AbortSignal): Promise<PageResource>;
  updatePage(id: string, input: UpdatePageInput, signal?: AbortSignal): Promise<PageResource>;
  movePage(id: string, input: MovePageInput, signal?: AbortSignal): Promise<PageResource>;
  trashPage(id: string, signal?: AbortSignal): Promise<{ status: "trashed"; pageIds: string[] }>;
  restorePage(id: string, signal?: AbortSignal): Promise<PageResource>;
  getComments(pageId: string, signal?: AbortSignal): Promise<PageComment[]>;
  createComment(pageId: string, bodyMd: string, signal?: AbortSignal): Promise<PageComment>;
  getVersions(pageId: string, signal?: AbortSignal): Promise<PageVersion[]>;
  restoreVersion(pageId: string, versionId: string, baseRevision: number, signal?: AbortSignal): Promise<PageResource>;
  search(input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  answer(query: string, knowledgeMode: "wiki_only" | "wiki_plus_general", signal?: AbortSignal): Promise<AnswerResponse>;
  createImport(input: ImportRequest, signal?: AbortSignal): Promise<ImportJob>;
  getImport(id: string, signal?: AbortSignal): Promise<ImportJob>;
  applyImport(id: string, input: ApplyImportInput, signal?: AbortSignal): Promise<PageResource>;
  createAccountLink(provider: BotProvider, signal?: AbortSignal): Promise<AccountLinkCode>;
  getLinkedBotAccounts(signal?: AbortSignal): Promise<LinkedBotAccount[]>;
  unlinkBotAccount(provider: BotProvider, signal?: AbortSignal): Promise<void>;
  getAdminMembers(signal?: AbortSignal): Promise<AdminMember[]>;
  updateAdminMember(id: string, input: UpdateAdminMemberRequest, signal?: AbortSignal): Promise<AdminMember>;
  getPageAcl(pageId: string, signal?: AbortSignal): Promise<PageAclResponse>;
  replacePageAcl(pageId: string, input: ReplacePageAclRequest, signal?: AbortSignal): Promise<PageAclResponse>;
  getBotSettings(signal?: AbortSignal): Promise<BotProviderSettings[]>;
  setBotProviderEnabled(provider: BotProvider, enabled: boolean, signal?: AbortSignal): Promise<BotProviderSettings[]>;
  createBotChannel(input: CreateBotChannelRequest, signal?: AbortSignal): Promise<BotChannel>;
  updateBotChannel(provider: BotProvider, externalChannelId: string, input: UpdateBotChannelRequest, signal?: AbortSignal): Promise<BotChannel>;
  deleteBotChannel(provider: BotProvider, externalChannelId: string, signal?: AbortSignal): Promise<void>;
}
import type {
  AdminMember,
  BotChannel,
  BotProviderSettings,
  CreateBotChannelRequest,
  LinkedBotAccount,
  PageAclResponse,
  ReplacePageAclRequest,
  UpdateAdminMemberRequest,
  UpdateBotChannelRequest,
} from "@nago-wiki/shared";

export type {
  AdminMember,
  BotChannel,
  BotProviderSettings,
  CreateBotChannelRequest,
  LinkedBotAccount,
  PageAclPermission,
  PageAclResponse,
  ReplacePageAclRequest,
  UpdateAdminMemberRequest,
  UpdateBotChannelRequest,
} from "@nago-wiki/shared";
