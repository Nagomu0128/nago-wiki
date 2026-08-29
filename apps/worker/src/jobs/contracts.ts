import { z } from "zod";

export const indexPageJobSchema = z.object({
  type: z.literal("index-page"),
  jobId: z.string().min(1),
  workspaceId: z.string().min(1),
  pageId: z.string().min(1),
  desiredHash: z.string().min(1),
});

export const botQueryJobSchema = z.object({
  type: z.literal("bot-query"),
  jobId: z.string().min(1),
  provider: z.enum(["line", "discord"]),
  eventId: z.string().min(1),
  externalUserId: z.string().min(1),
  externalChannelId: z.string().min(1).nullable(),
  query: z.string().min(1).max(5_000),
  response: z.discriminatedUnion("kind", [
    // Old queue messages may remain in flight while the Worker rolls out.
    z.object({ kind: z.literal("line-push") }),
    z.object({
      kind: z.literal("line-reply-then-push"),
      // This credential is intentionally ephemeral: it is carried only by the
      // queue message, never persisted in D1, and is omitted from all logs.
      replyToken: z.string().min(1).max(4_096),
      replyExpiresAt: z.number().int().nonnegative(),
    }),
  ]),
});

export const persistVersionJobSchema = z.object({
  type: z.literal("persist-version"),
  jobId: z.string().min(1),
  versionId: z.string().min(1),
});

export const asyncJobSchema = z.discriminatedUnion("type", [
  indexPageJobSchema,
  botQueryJobSchema,
  persistVersionJobSchema,
]);
export type AsyncJob = z.infer<typeof asyncJobSchema>;
export type IndexPageJob = z.infer<typeof indexPageJobSchema>;
export type BotQueryJob = z.infer<typeof botQueryJobSchema>;
export type PersistVersionJob = z.infer<typeof persistVersionJobSchema>;
