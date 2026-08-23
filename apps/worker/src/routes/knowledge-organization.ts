import { Hono } from "hono";
import { z } from "zod";

import {
  coreErrorHandler,
  coreRequestContext,
  type CoreHonoEnv,
  requireIdentity,
} from "../core/context";
import { ApiProblem } from "../core/errors";
import { KnowledgeOrganizationService } from "../core/knowledge-organization-service";

const pageIdSchema = z.uuid();

export function createKnowledgeOrganizationRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();
  routes.onError(coreErrorHandler);
  routes.use("*", coreRequestContext);

  routes.get("/recent", async (context) => {
    const pages = await new KnowledgeOrganizationService(
      context.env.DB,
    ).listRecent(requireIdentity(context));
    return context.json({ pages });
  });

  routes.get("/favorites", async (context) => {
    const pages = await new KnowledgeOrganizationService(
      context.env.DB,
    ).listFavorites(requireIdentity(context));
    return context.json({ pages });
  });

  routes.get("/trash", async (context) => {
    const pages = await new KnowledgeOrganizationService(
      context.env.DB,
    ).listTrash(requireIdentity(context));
    return context.json({ pages });
  });

  routes.post("/pages/:id/view", async (context) => {
    await new KnowledgeOrganizationService(context.env.DB).recordPageView(
      requireIdentity(context),
      parsePageId(context.req.param("id")),
    );
    return context.body(null, 204);
  });

  routes.put("/pages/:id/favorite", async (context) => {
    await new KnowledgeOrganizationService(context.env.DB).setFavorite(
      requireIdentity(context),
      parsePageId(context.req.param("id")),
      true,
    );
    return context.json({ favorite: true as const });
  });

  routes.delete("/pages/:id/favorite", async (context) => {
    await new KnowledgeOrganizationService(context.env.DB).setFavorite(
      requireIdentity(context),
      parsePageId(context.req.param("id")),
      false,
    );
    return context.json({ favorite: false as const });
  });

  return routes;
}

function parsePageId(value: string): string {
  const parsed = pageIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiProblem(
      "PAGE_NOT_FOUND",
      404,
      "Page was not found or is not visible",
    );
  }
  return parsed.data;
}
