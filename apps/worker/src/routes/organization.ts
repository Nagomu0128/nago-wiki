import { Hono } from "hono";
import { z } from "zod";

import { requireIdentity, type CoreHonoEnv } from "../core/context";
import { ApiProblem } from "../core/errors";
import { TagsService } from "../core/tags-service";
import { McpWikiRepository } from "../mcp/repository";

const replaceTagsSchema = z.object({
  names: z.array(z.string().trim().min(1).max(100)).max(50),
});

export function createOrganizationRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();

  routes.get("/tags", async (context) => {
    const tags = await new TagsService(context.env.DB).listVisible(
      requireIdentity(context),
    );
    return context.json({ tags });
  });

  routes.put("/pages/:id/tags", async (context) => {
    const parsed = replaceTagsSchema.safeParse(await context.req.json());
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
    const repository = new McpWikiRepository(
      context.env.DB,
      new URL(context.env.MCP_PUBLIC_ORIGIN).origin,
    );
    const target = await repository.getPage(
      identity.id,
      identity.workspaceId,
      context.req.param("id"),
    );
    if (target === null) {
      throw new ApiProblem("PAGE_NOT_FOUND", 404, "Page was not found or is not visible");
    }
    const pages = await repository.getBacklinks(
      identity.id,
      identity.workspaceId,
      target.id,
    );
    return context.json({
      pages: pages.map((page) => ({
        id: page.id,
        title: page.title,
        path: page.path,
        url: page.url,
      })),
    });
  });

  return routes;
}
