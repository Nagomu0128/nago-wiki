import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { D1SearchCandidateAuthorizer } from "../ai/authorizer";
import { recordChatAudit } from "../ai/audit";
import { WikiAnswerService, WorkersAiAnswerModel } from "../ai/answer-service";
import { WikiSearchService } from "../ai/search-service";
import { decodeCursor, encodeCursor } from "./pagination";
import { McpWikiRepository } from "./repository";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

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
        query: z.string().min(1).max(2_000),
        mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid"),
        limit: z.number().int().min(1).max(50).default(20),
        pathPrefix: z.string().max(2_000).optional(),
        tags: z.array(z.string().min(1).max(100)).max(20).optional(),
      }),
    },
    async ({ query, mode, limit, pathPrefix, tags }) => {
      const result = await search.search(auth.userId, {
        workspaceId: auth.workspaceId,
        query,
        mode,
        limit,
        tags,
      });
      return jsonResult({
        ...result,
        results:
          pathPrefix === undefined
            ? result.results
            : result.results.filter((hit) => hit.path.startsWith(pathPrefix)),
      });
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Get wiki page",
      description: "Get the canonical Markdown body of a readable wiki page.",
      inputSchema: z
        .object({
          pageId: z.string().min(1).max(128).optional(),
          path: z.string().min(1).max(2_000).optional(),
        })
        .refine((value) => value.pageId !== undefined || value.path !== undefined, {
          message: "pageId or path is required",
        }),
    },
    async ({ pageId, path }) => {
      const page = pageId === undefined
        ? await repository.getPageByPath(auth.userId, auth.workspaceId, path ?? "")
        : await repository.getPage(auth.userId, auth.workspaceId, pageId);
      return page === null ? errorResult("Page not found or not readable") : jsonResult(page);
    },
  );

  server.registerTool(
    "list_children",
    {
      title: "List child pages",
      description: "List readable direct children of a page, or root pages when parentPageId is omitted.",
      inputSchema: z.object({
        parentPageId: z.string().min(1).max(128).nullable().default(null),
        cursor: z.string().max(2_000).optional(),
        limit: z.number().int().min(1).max(50).default(50),
      }),
    },
    async ({ parentPageId, cursor, limit }) => {
      const cursorContext = {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        collection: "children" as const,
        targetPageId: parentPageId,
      };
      const decodedCursor = await decodeCursor(
        cursor,
        environment.TOKEN_ENCRYPTION_KEY,
        cursorContext,
      );
      if (cursor !== undefined && decodedCursor === null) {
        return errorResult("Invalid pagination cursor");
      }
      const children = await repository.listChildren(
        auth.userId,
        auth.workspaceId,
        parentPageId,
        decodedCursor,
        limit,
      );
      return jsonResult({
        pages: children.pages,
        cursor:
          children.nextCursor === null
            ? null
            : await encodeCursor(
                children.nextCursor,
                environment.TOKEN_ENCRYPTION_KEY,
                cursorContext,
              ),
      });
    },
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get backlinks",
      description: "List readable pages that link to the target wiki page.",
      inputSchema: z.object({
        pageId: z.string().min(1).max(128),
        cursor: z.string().max(2_000).optional(),
        limit: z.number().int().min(1).max(50).default(50),
      }),
    },
    async ({ pageId, cursor, limit }) => {
      const cursorContext = {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        collection: "backlinks" as const,
        targetPageId: pageId,
      };
      const decodedCursor = await decodeCursor(
        cursor,
        environment.TOKEN_ENCRYPTION_KEY,
        cursorContext,
      );
      if (cursor !== undefined && decodedCursor === null) {
        return errorResult("Invalid pagination cursor");
      }
      const backlinks = await repository.getBacklinks(
        auth.userId,
        auth.workspaceId,
        pageId,
        decodedCursor,
        limit,
      );
      if (backlinks === null) {
        return errorResult("Page not found or not readable");
      }
      return jsonResult({
        pages: backlinks.pages,
        cursor:
          backlinks.nextCursor === null
            ? null
            : await encodeCursor(
                backlinks.nextCursor,
                environment.TOKEN_ENCRYPTION_KEY,
                cursorContext,
              ),
      });
    },
  );

  server.registerTool(
    "ask_wiki",
    {
      title: "Ask wiki",
      description: "Answer a question with ACL-filtered wiki evidence and citations.",
      inputSchema: z.object({
        query: z.string().min(1).max(2_000),
        knowledgeMode: z.enum(["wiki_only", "wiki_plus_general"]).default("wiki_only"),
      }),
    },
    async ({ query, knowledgeMode }) => {
      const result = await answer.answer(auth.userId, {
          workspaceId: auth.workspaceId,
          query,
          knowledgeMode,
          maxCitations: 8,
        });
      await recordChatAudit(environment.DB, {
        provider: "mcp",
        userId: auth.userId,
        query,
        pageIds: result.citations.map((citation) => citation.pageId),
        answerSummary: result.answer,
      });
      return jsonResult(result);
    },
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
