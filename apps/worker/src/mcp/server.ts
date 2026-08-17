import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { D1SearchCandidateAuthorizer } from "../ai/authorizer";
import { WikiAnswerService, WorkersAiAnswerModel } from "../ai/answer-service";
import { WikiSearchService } from "../ai/search-service";
import { McpWikiRepository } from "./repository";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

const workspaceInput = {
  workspaceId: z.string().min(1).max(128),
};

export function createWikiMcpServer(
  environment: McpRuntimeEnv,
  auth: McpAuthProps,
): McpServer {
  const server = new McpServer({ name: "nago-wiki", version: "0.1.0" });
  const publicOrigin = new URL(environment.MCP_PUBLIC_ORIGIN).origin;
  const repository = new McpWikiRepository(environment.DB, publicOrigin);
  const search = new WikiSearchService(
    environment.WIKI_SEARCH,
    new D1SearchCandidateAuthorizer(environment.DB, publicOrigin),
  );
  const answer = new WikiAnswerService(
    search,
    new WorkersAiAnswerModel(
      environment.AI,
      environment.ANSWER_MODEL,
      environment.AI_GATEWAY_ID,
    ),
  );

  server.registerTool(
    "search_wiki",
    {
      title: "Search wiki",
      description: "Search readable wiki pages using semantic and keyword retrieval.",
      inputSchema: z.object({
        ...workspaceInput,
        query: z.string().min(1).max(2_000),
        limit: z.number().int().min(1).max(20).default(8),
      }),
    },
    async ({ workspaceId, query, limit }) =>
      jsonResult(await search.search(auth.userId, { workspaceId, query, limit })),
  );

  server.registerTool(
    "get_page",
    {
      title: "Get wiki page",
      description: "Get the canonical Markdown body of a readable wiki page.",
      inputSchema: z.object({
        ...workspaceInput,
        pageId: z.string().min(1).max(128),
      }),
    },
    async ({ workspaceId, pageId }) => {
      const page = await repository.getPage(auth.userId, workspaceId, pageId);
      return page === null ? errorResult("Page not found or not readable") : jsonResult(page);
    },
  );

  server.registerTool(
    "list_children",
    {
      title: "List child pages",
      description: "List readable direct children of a page, or root pages when parentPageId is omitted.",
      inputSchema: z.object({
        ...workspaceInput,
        parentPageId: z.string().min(1).max(128).nullable().default(null),
      }),
    },
    async ({ workspaceId, parentPageId }) =>
      jsonResult(await repository.listChildren(auth.userId, workspaceId, parentPageId)),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get backlinks",
      description: "List readable pages that link to the target wiki page.",
      inputSchema: z.object({
        ...workspaceInput,
        pageId: z.string().min(1).max(128),
      }),
    },
    async ({ workspaceId, pageId }) =>
      jsonResult(await repository.getBacklinks(auth.userId, workspaceId, pageId)),
  );

  server.registerTool(
    "ask_wiki",
    {
      title: "Ask wiki",
      description: "Answer a question with ACL-filtered wiki evidence and citations.",
      inputSchema: z.object({
        ...workspaceInput,
        query: z.string().min(1).max(2_000),
        knowledgeMode: z.enum(["wiki_only", "wiki_plus_general"]).default("wiki_only"),
      }),
    },
    async ({ workspaceId, query, knowledgeMode }) =>
      jsonResult(
        await answer.answer(auth.userId, {
          workspaceId,
          query,
          knowledgeMode,
          maxCitations: 8,
        }),
      ),
  );

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
