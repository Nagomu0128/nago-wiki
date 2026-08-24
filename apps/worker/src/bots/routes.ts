import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { issueAccountLinkCode } from "./account-link";
import { handleLineWebhook } from "./line";
import {
  answerBotQuery,
  BotEventInProgressError,
  reserveBotEvent,
} from "./service";
import { verifyBridgeSignature } from "./signatures";
import { readBoundedText } from "../core/bounded-body";
import type { McpRuntimeEnv } from "../mcp/types";

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

const discordSessionSchema = z.object({
  resumeURL: z.url().refine((value) => new URL(value).protocol === "wss:"),
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(512),
  shardCount: z.number().int().positive().max(1_000),
  shardId: z.number().int().nonnegative().max(999),
});

const MAX_DISCORD_QUERY_BYTES = 64 * 1024;
const MAX_DISCORD_SESSION_BYTES = 16 * 1024;

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

  routes.post("/internal/bot-query", async (context) => {
    const body = await readBoundedText(context.req.raw, MAX_DISCORD_QUERY_BYTES);
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

  routes.get("/internal/discord-session/:shardId", async (context) => {
    await requireBridgeSignature(context.req.raw, context.env.DISCORD_BRIDGE_SECRET, "");
    const shardId = parseShardId(context.req.param("shardId"));
    const session = await context.env.DISCORD_GATEWAY
      .getByName("gateway")
      .getGatewaySession(shardId);
    return context.json({ session });
  });

  routes.put("/internal/discord-session/:shardId", async (context) => {
    const body = await readBoundedText(context.req.raw, MAX_DISCORD_SESSION_BYTES);
    await requireBridgeSignature(context.req.raw, context.env.DISCORD_BRIDGE_SECRET, body);
    const shardId = parseShardId(context.req.param("shardId"));
    const parsed = z.object({ session: discordSessionSchema.nullable() }).safeParse(
      parseJson(body),
    );
    if (
      !parsed.success ||
      (parsed.data.session !== null && parsed.data.session.shardId !== shardId)
    ) {
      throw new HTTPException(400, { message: "Invalid Discord session" });
    }
    await context.env.DISCORD_GATEWAY
      .getByName("gateway")
      .saveGatewaySession(
        shardId,
        parsed.data.session,
      );
    return context.body(null, 204);
  });

  return routes;
}

async function requireBridgeSignature(
  request: Request,
  secret: string,
  body: string,
): Promise<void> {
  const verified = await verifyBridgeSignature(
    body,
    request.headers.get("x-nago-timestamp"),
    request.headers.get("x-nago-signature"),
    secret,
  );
  if (!verified) throw new HTTPException(401, { message: "Invalid bridge signature" });
}

function parseShardId(value: string): number {
  if (!/^\d{1,3}$/u.test(value)) {
    throw new HTTPException(400, { message: "Invalid Discord shard" });
  }
  return Number(value);
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
