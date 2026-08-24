import {
  botProviderSchema,
  createBotChannelRequestSchema,
  externalBotChannelIdSchema,
  replacePageAclRequestSchema,
  updateAdminMemberRequestSchema,
  updateBotChannelRequestSchema,
  updateBotProviderRequestSchema,
} from "@nago-wiki/shared";
import { Hono } from "hono";

import { requireIdentity, type CoreHonoEnv } from "../core/context";
import { readBoundedText } from "../core/bounded-body";
import { ApiProblem } from "../core/errors";
import { AdminService } from "./service";

const MAX_ADMIN_JSON_BYTES = 64 * 1024;

export function createAdminRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();

  routes.get("/admin/members", async (context) => {
    const members = await service(context).listMembers(requireIdentity(context));
    return context.json({ members });
  });

  routes.patch("/admin/members/:id", async (context) => {
    const request = updateAdminMemberRequestSchema.safeParse(await readJson(context.req.raw));
    if (!request.success) throw invalidRequest("Invalid member update");
    const member = await service(context).updateMember(
      requireIdentity(context),
      context.req.param("id"),
      request.data,
    );
    return context.json({ member });
  });

  routes.get("/pages/:id/acl", async (context) => {
    const acl = await service(context).getPageAcl(
      requireIdentity(context),
      context.req.param("id"),
    );
    return context.json(acl);
  });

  routes.put("/pages/:id/acl", async (context) => {
    const request = replacePageAclRequestSchema.safeParse(await readJson(context.req.raw));
    if (!request.success) throw invalidRequest("Invalid page access list");
    const acl = await service(context).replacePageAcl(
      requireIdentity(context),
      context.req.param("id"),
      request.data,
    );
    return context.json(acl);
  });

  routes.get("/admin/bots", async (context) => {
    return context.json(await service(context).getBotSettings(requireIdentity(context)));
  });

  routes.put("/admin/bots/:provider", async (context) => {
    const provider = botProviderSchema.safeParse(context.req.param("provider"));
    const request = updateBotProviderRequestSchema.safeParse(await readJson(context.req.raw));
    if (!provider.success || !request.success) throw invalidRequest("Invalid bot provider update");
    return context.json(
      await service(context).setBotProviderEnabled(
        requireIdentity(context),
        provider.data,
        request.data.enabled,
      ),
    );
  });

  routes.post("/admin/bot-channels", async (context) => {
    const request = createBotChannelRequestSchema.safeParse(await readJson(context.req.raw));
    if (!request.success) throw invalidRequest("Invalid bot channel");
    const channel = await service(context).createBotChannel(
      requireIdentity(context),
      request.data,
    );
    return context.json({ channel }, 201);
  });

  routes.patch("/admin/bot-channels/:provider/:channelId", async (context) => {
    const provider = botProviderSchema.safeParse(context.req.param("provider"));
    const channelId = externalBotChannelIdSchema.safeParse(context.req.param("channelId"));
    const request = updateBotChannelRequestSchema.safeParse(await readJson(context.req.raw));
    if (!provider.success || !channelId.success || !request.success) throw invalidRequest("Invalid bot channel update");
    const channel = await service(context).updateBotChannel(
      requireIdentity(context),
      provider.data,
      channelId.data,
      request.data,
    );
    return context.json({ channel });
  });

  routes.delete("/admin/bot-channels/:provider/:channelId", async (context) => {
    const provider = botProviderSchema.safeParse(context.req.param("provider"));
    const channelId = externalBotChannelIdSchema.safeParse(context.req.param("channelId"));
    if (!provider.success || !channelId.success) throw invalidRequest("Invalid bot channel");
    await service(context).deleteBotChannel(
      requireIdentity(context),
      provider.data,
      channelId.data,
    );
    return context.body(null, 204);
  });

  return routes;
}

function service(context: { env: Env }): AdminService {
  return new AdminService(context.env.DB);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedText(request, MAX_ADMIN_JSON_BYTES));
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    return null;
  }
}

function invalidRequest(message: string): ApiProblem {
  return new ApiProblem("INVALID_REQUEST", 400, message);
}
