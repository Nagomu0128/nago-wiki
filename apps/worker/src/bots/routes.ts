import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  issueAccountLinkCode,
  listLinkedBotAccounts,
  unlinkBotAccount,
} from "./account-link";
import { handleLineWebhook } from "./line";
import {
  answerBotQuery,
  BotEventInProgressError,
  reserveBotEvent,
} from "./service";
import { verifyBridgeSignature } from "./signatures";
import type { McpRuntimeEnv } from "../mcp/types";
import { ApiProblem } from "../core/errors";

interface BotApi {
  Bindings: McpRuntimeEnv;
  Variables: { userId: string };
}

const issueLinkSchema = z.object({
  provider: z.enum(["discord", "line"]).nullable().default(null),
});

const discordQuerySchema = z.object({
  provider: z.literal("discord"),
  eventId: z.string().min(1).max(128),
  externalUserId: z.string().min(1).max(128),
  externalChannelId: z.string().min(1).max(128).nullable(),
  query: z.string().trim().min(1).max(5_000),
});

export function createBotRoutes(): Hono<BotApi> {
  const routes = new Hono<BotApi>();

  routes.post("/webhooks/line", (context) =>
    handleLineWebhook(context.req.raw, context.env),
  );

  routes.post(
    "/account-links",
    zValidator("json", issueLinkSchema),
    async (context) => {
      const userId = requireUserId(context.get("userId"));
      const member = await context.env.DB.prepare(
        `SELECT id FROM users WHERE id = ?1 AND status = 'active'`,
      )
        .bind(userId)
        .first<{ id: string }>();
      if (member === null) throw new HTTPException(401, { message: "Authentication required" });
      const result = await issueAccountLinkCode(
        context.env.DB,
        userId,
        context.req.valid("json").provider,
      );
      return context.json(result, 201);
    },
  );

  routes.get("/account-links", async (context) => {
    const userId = requireUserId(context.get("userId"));
    const accounts = await listLinkedBotAccounts(context.env.DB, userId);
    return context.json({ accounts });
  });

  routes.delete("/account-links/:provider", async (context) => {
    const provider = context.req.param("provider");
    if (provider !== "discord" && provider !== "line") {
      throw new ApiProblem("INVALID_REQUEST", 400, "Invalid bot provider");
    }
    const userId = requireUserId(context.get("userId"));
    await unlinkBotAccount(context.env.DB, userId, provider);
    return context.body(null, 204);
  });

  routes.post("/internal/bot-query", async (context) => {
    const body = await context.req.text();
    const verified = await verifyBridgeSignature(
      body,
      context.req.header("x-nago-timestamp") ?? null,
      context.req.header("x-nago-signature") ?? null,
      context.env.DISCORD_BRIDGE_SECRET,
    );
    if (!verified) throw new HTTPException(401, { message: "Invalid bridge signature" });
    const request = discordQuerySchema.safeParse(parseJson(body));
    if (!request.success) throw new HTTPException(400, { message: "Invalid bot query" });
    await reserveBotEvent(context.env.DB, "discord", request.data.eventId);
    try {
      const answer = await answerBotQuery(context.env, request.data);
      return context.json({ answer });
    } catch (error) {
      if (error instanceof BotEventInProgressError) {
        return context.json(
          { pending: true as const },
          202,
          { "Retry-After": "1" },
        );
      }
      throw error;
    }
  });

  return routes;
}

function requireUserId(contextUserId: string | undefined): string {
  if (contextUserId === undefined || contextUserId.length === 0) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return contextUserId;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
