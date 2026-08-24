import { Hono } from "hono";
import { z } from "zod";

import { requireIdentity, type CoreHonoEnv } from "../core/context";
import { readBoundedText } from "../core/bounded-body";
import { ApiProblem } from "../core/errors";
import { TagsService } from "../core/tags-service";
import { decodeCursor, encodeCursor } from "../mcp/pagination";
import { McpWikiRepository } from "../mcp/repository";
import type { McpRuntimeEnv } from "../mcp/types";

const replaceTagsSchema = z.object({
  names: z.array(z.string().trim().min(1).max(100)).max(50),
});
const MAX_TAG_BODY_BYTES = 16 * 1_024;

export function createOrganizationRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();

  routes.get("/tags", async (context) => {
    const tags = await new TagsService(context.env.DB).listVisible(
      requireIdentity(context),
    );
    return context.json({ tags });
  });

  routes.put("/pages/:id/tags", async (context) => {
    let body: unknown;
    try {
      body = JSON.parse(
        await readBoundedText(context.req.raw, MAX_TAG_BODY_BYTES),
      ) as unknown;
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem("INVALID_REQUEST", 400, "Invalid JSON request body");
    }
    const parsed = replaceTagsSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiProblem("INVALID_REQUEST", 400, "Invalid tag selection");
    }
    const tags = await new TagsService(context.env.DB).replacePageTags(
      requireIdentity(context),
      context.req.param("id"),
      parsed.data.names,
    );
    return context.json({ tags });
  });

  routes.get("/pages/:id/backlinks", async (context) => {
    const identity = requireIdentity(context);
    const encodedCursor = context.req.query("cursor");
    const cursorContext = {
      userId: identity.id,
      workspaceId: identity.workspaceId,
      collection: "backlinks" as const,
      targetPageId: context.req.param("id"),
    };
    const tokenEncryptionKey = (context.env as McpRuntimeEnv).TOKEN_ENCRYPTION_KEY;
    const cursor = await decodeCursor(
      encodedCursor,
      tokenEncryptionKey,
      cursorContext,
    );
    const requestedLimit = Number.parseInt(context.req.query("limit") ?? "50", 10);
    if (
      (encodedCursor !== undefined && cursor === null) ||
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 50
    ) {
      throw new ApiProblem("INVALID_REQUEST", 400, "Invalid pagination parameters");
    }
    const repository = new McpWikiRepository(
      context.env.DB,
      new URL(context.env.MCP_PUBLIC_ORIGIN).origin,
    );
    const result = await repository.getBacklinks(
      identity.id,
      identity.workspaceId,
      context.req.param("id"),
      cursor,
      requestedLimit,
    );
    if (result === null) {
      throw new ApiProblem("PAGE_NOT_FOUND", 404, "Page was not found or is not visible");
    }
    return context.json({
      pages: result.pages.map((page) => ({
        id: page.id,
        title: page.title,
        path: page.path,
        url: page.url,
      })),
      cursor:
        result.nextCursor === null
          ? null
          : await encodeCursor(
              result.nextCursor,
              tokenEncryptionKey,
              cursorContext,
            ),
    });
  });

  return routes;
}
