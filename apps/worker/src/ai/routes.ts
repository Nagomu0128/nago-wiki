import { zValidator } from "@hono/zod-validator";
import {
  answerRequestSchema as publicAnswerRequestSchema,
  searchRequestSchema as publicSearchRequestSchema,
} from "@nago-wiki/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { D1SearchCandidateAuthorizer } from "./authorizer";
import { WikiAnswerService, WorkersAiAnswerModel } from "./answer-service";
import { recordChatAudit } from "./audit";
import { WikiSearchService } from "./search-service";

interface AiApi {
  Bindings: Env;
  Variables: { userId: string | undefined; requestId: string | undefined };
}

export function createAiRoutes(): Hono<AiApi> {
  const routes = new Hono<AiApi>();

  routes.post("/search", zValidator("json", publicSearchRequestSchema), async (context) => {
    const services = createServices(context.env);
    const request = context.req.valid("json");
    const result = await services.search.search(
      requireUserId(context.get("userId"), context.req.header("x-nago-user-id")),
      {
        query: request.query,
        workspaceId: context.env.WORKSPACE_ID,
        mode: request.mode,
        parentPageId: request.parentPageId,
        tagIds: request.tagIds,
        limit: request.limit,
      },
    );
    return context.json({
      hits: result.results.map((hit) => ({
        pageId: hit.pageId,
        title: hit.title,
        path: hit.path,
        url: hit.url,
        snippet: hit.snippet,
        score: hit.score,
        source: request.mode === "keyword" ? "keyword" as const : "semantic" as const,
        contentHash: hit.contentHash,
      })),
      cursor: null,
    });
  });

  routes.post("/answer", zValidator("json", publicAnswerRequestSchema), async (context) => {
    const services = createServices(context.env);
    const request = context.req.valid("json");
    const userId = requireUserId(
      context.get("userId"),
      context.req.header("x-nago-user-id"),
    );
    const result = await services.answer.answer(
      userId,
      {
        query: request.query,
        workspaceId: context.env.WORKSPACE_ID,
        knowledgeMode: request.knowledgeMode,
        maxCitations: 8,
        conversation: request.conversation,
        mode: "hybrid",
      },
    );
    await recordChatAudit(context.env.DB, {
      provider: "web",
      userId,
      query: request.query,
      pageIds: result.citations.map((citation) => citation.pageId),
      answerSummary: result.answer,
    });
    return context.json({
      state: result.state,
      answerMarkdown: result.answer,
      citations: result.citations.map((citation) => ({
        id: citation.chunkId,
        pageId: citation.pageId,
        title: citation.title,
        path: citation.path,
        url: citation.url,
        snippet: citation.snippet,
        contentHash: citation.contentHash,
      })),
      requestId: context.get("requestId") ?? `req_${crypto.randomUUID()}`,
    });
  });

  return routes;
}

function createServices(environment: Env): {
  search: WikiSearchService;
  answer: WikiAnswerService;
} {
  const publicOrigin = new URL(environment.MCP_PUBLIC_ORIGIN).origin;
  const authorizer = new D1SearchCandidateAuthorizer(environment.DB, publicOrigin);
  const search = new WikiSearchService(environment.WIKI_SEARCH, authorizer);
  const model = new WorkersAiAnswerModel(
    environment.AI,
    environment.ANSWER_MODEL,
    environment.AI_GATEWAY_ID,
  );
  return { search, answer: new WikiAnswerService(search, model) };
}

function requireUserId(contextUserId: string | undefined, headerUserId: string | undefined): string {
  const userId = contextUserId ?? headerUserId;
  if (userId === undefined || userId.length === 0) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return userId;
}
