import { z } from "zod";

import type { BotQueryJob } from "../jobs/contracts";
import type { McpRuntimeEnv } from "../mcp/types";
import { reserveBotEvent } from "./service";
import { verifyLineSignature } from "./signatures";

const mentioneeSchema = z.object({
  isSelf: z.boolean().optional(),
  index: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

const lineEventSchema = z.object({
  type: z.literal("message"),
  webhookEventId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  replyToken: z.string().min(1),
  source: z.object({
    type: z.enum(["user", "group", "room"]),
    userId: z.string().min(1),
    groupId: z.string().optional(),
    roomId: z.string().optional(),
  }),
  message: z.object({
    type: z.literal("text"),
    text: z.string(),
    mention: z.object({ mentionees: z.array(mentioneeSchema) }).optional(),
  }),
});

const webhookSchema = z.object({ events: z.array(z.unknown()).max(100) });

export async function handleLineWebhook(
  request: Request,
  environment: McpRuntimeEnv,
): Promise<Response> {
  const body = await request.text();
  if (
    !(await verifyLineSignature(
      body,
      request.headers.get("x-line-signature"),
      environment.LINE_CHANNEL_SECRET,
    ))
  ) {
    return new Response("Invalid signature", { status: 401 });
  }
  const parsed = webhookSchema.safeParse(parseJson(body));
  if (!parsed.success) return new Response("Invalid webhook", { status: 400 });

  for (const rawEvent of parsed.data.events) {
    const event = lineEventSchema.safeParse(rawEvent);
    if (!event.success || Math.abs(Date.now() - event.data.timestamp) > 10 * 60 * 1_000) {
      continue;
    }
    const query = extractLineQuery(event.data.source.type, event.data.message);
    if (query === null || query.length === 0) continue;
    if (!(await reserveBotEvent(environment.DB, "line", event.data.webhookEventId))) {
      continue;
    }
    const externalChannelId =
      event.data.source.type === "group"
        ? (event.data.source.groupId ?? null)
        : event.data.source.type === "room"
          ? (event.data.source.roomId ?? null)
          : null;
    const job: BotQueryJob = {
      type: "bot-query",
      jobId: crypto.randomUUID(),
      provider: "line",
      eventId: event.data.webhookEventId,
      externalUserId: event.data.source.userId,
      externalChannelId,
      query,
      response: { kind: "line-reply", replyToken: event.data.replyToken },
    };
    try {
      await environment.ASYNC_JOBS.send(job, { contentType: "json" });
    } catch (error) {
      // The provider will retry a non-2xx webhook. Release only this fresh
      // reservation so that retry can enqueue it instead of treating it as a
      // successfully accepted duplicate.
      await environment.DB.prepare(
        `DELETE FROM bot_events
          WHERE provider = 'line' AND event_id = ?1 AND status = 'received'`,
      )
        .bind(event.data.webhookEventId)
        .run();
      throw error;
    }
  }
  return new Response("OK");
}

export async function sendLineReply(
  environment: Pick<McpRuntimeEnv, "LINE_CHANNEL_ACCESS_TOKEN">,
  replyToken: string,
  text: string,
  pushTarget?: string,
): Promise<void> {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (response.ok) return;
  if (pushTarget === undefined) {
    throw new Error(`LINE reply failed with status ${String(response.status)}`);
  }
  const push = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: pushTarget, messages: [{ type: "text", text }] }),
  });
  if (!push.ok) {
    throw new Error(
      `LINE reply and push failed with statuses ${String(response.status)}/${String(push.status)}`,
    );
  }
}

export function extractLineQuery(
  sourceType: "user" | "group" | "room",
  message: z.infer<typeof lineEventSchema>["message"],
): string | null {
  const selfMentions = (message.mention?.mentionees ?? []).filter(
    (mention) => mention.isSelf === true,
  );
  if (sourceType !== "user" && selfMentions.length === 0) return null;
  let text = message.text;
  for (const mention of [...selfMentions].sort((left, right) => right.index - left.index)) {
    text = text.slice(0, mention.index) + text.slice(mention.index + mention.length);
  }
  return text.trim();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
