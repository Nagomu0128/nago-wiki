import { asyncJobSchema, type AsyncJob } from "./contracts";
import { indexPage } from "./index-page";
import { persistPageVersion } from "./persist-version";
import { answerBotQuery } from "../bots/service";
import {
  LineReplyPermanentError,
  LineReplyUnavailableError,
  sendLinePush,
  sendLineReply,
} from "../bots/line";
import type { McpRuntimeEnv } from "../mcp/types";

export async function consumeAsyncJobs(
  batch: MessageBatch,
  environment: McpRuntimeEnv,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const parsed = asyncJobSchema.safeParse(message.body);
      if (!parsed.success) {
        console.error("Discarding invalid async job", {
          messageId: message.id,
          reason: "schema_validation_failed",
        });
        message.ack();
        return;
      }

      try {
        await dispatchJob(environment, parsed.data);
        message.ack();
      } catch (error) {
        if (error instanceof LineReplyPermanentError) {
          console.error("Discarding permanently failed async job", {
            messageId: message.id,
            jobId: parsed.data.jobId,
            jobType: parsed.data.type,
            error: error.message,
          });
          message.ack();
          return;
        }
        console.error("Async job failed", {
          messageId: message.id,
          jobId: parsed.data.jobId,
          jobType: parsed.data.type,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }),
  );
}

async function dispatchJob(environment: McpRuntimeEnv, job: AsyncJob): Promise<void> {
  switch (job.type) {
    case "index-page":
      await indexPage(
        { database: environment.DB, search: environment.WIKI_SEARCH },
        job,
      );
      return;
    case "bot-query": {
      const response = await answerBotQuery(environment, job);
      if (response !== null) {
        await deliverLineBotResponse(environment, job, response);
      }
      return;
    }
    case "persist-version":
      await persistPageVersion(environment.DB, environment.FILES, job);
  }
}

export async function deliverLineBotResponse(
  environment: McpRuntimeEnv,
  job: Extract<AsyncJob, { type: "bot-query" }>,
  response: string,
  now = Date.now(),
): Promise<void> {
  const target = job.externalChannelId ?? job.externalUserId;
  const delivery = job.response;
  if (delivery.kind === "line-push") {
    await sendLinePush(environment, target, response, job.eventId);
    return;
  }

  // A previously selected push fallback is retried with LINE's deterministic
  // retry key; it must never cross back to reply.
  if (await sendClaimedLinePush(environment, target, response, job.eventId)) return;

  if (now >= delivery.replyExpiresAt) {
    if (await claimLinePushFallback(environment.DB, job.eventId, null)) {
      await sendClaimedLinePush(environment, target, response, job.eventId);
    }
    return;
  }

  const replyAttempt = await claimLineReplyAttempt(environment.DB, job.eventId);
  if (replyAttempt === null) return;
  try {
    await sendLineReply(environment, delivery.replyToken, response);
    await markLineDeliveryDelivered(environment.DB, job.eventId);
  } catch (error) {
    if (error instanceof LineReplyUnavailableError) {
      // Only an unequivocal 400 from the very first reply attempt may use
      // push. A previous attempt could have been delivered despite its result
      // being unknown, so later 400 responses must never cross to push.
      if (replyAttempt.number === 1
        && await claimLinePushFallback(environment.DB, job.eventId, replyAttempt.id)) {
        await sendClaimedLinePush(environment, target, response, job.eventId);
      } else {
        await markLineDeliveryPermanentFailure(
          environment.DB,
          job.eventId,
          replyAttempt.id,
        );
      }
      return;
    }
    if (error instanceof LineReplyPermanentError) {
      await markLineDeliveryPermanentFailure(environment.DB, job.eventId, replyAttempt.id);
    }
    throw error;
  }
}

interface ReplyAttempt {
  id: string;
  number: number;
}

interface ReplyAttemptRow {
  line_reply_attempts: number;
}

async function claimLineReplyAttempt(
  database: D1Database,
  eventId: string,
): Promise<ReplyAttempt | null> {
  const id = crypto.randomUUID();
  const row = await database
    .prepare(
      `UPDATE bot_events
          SET line_delivery_state = 'reply_attempted',
              line_reply_attempts = line_reply_attempts + 1,
              line_delivery_attempt_id = ?2,
              updated_at = ?3
        WHERE provider = 'line' AND event_id = ?1
          AND line_delivery_state IN ('pending', 'reply_attempted')
        RETURNING line_reply_attempts`,
    )
    .bind(eventId, id, new Date().toISOString())
    .first<ReplyAttemptRow>();
  return row === null ? null : { id, number: row.line_reply_attempts };
}

async function claimLinePushFallback(
  database: D1Database,
  eventId: string,
  replyAttemptId: string | null,
): Promise<boolean> {
  if (replyAttemptId === null) {
    const claimed = await database.prepare(
      `UPDATE bot_events
          SET line_delivery_state = 'push_pending', updated_at = ?2
        WHERE provider = 'line' AND event_id = ?1
          AND line_delivery_state = 'pending'
        RETURNING event_id`,
    )
      .bind(eventId, new Date().toISOString())
      .first<{ event_id: string }>();
    return claimed !== null;
  }
  const claimed = await database.prepare(
    `UPDATE bot_events
          SET line_delivery_state = 'push_pending', updated_at = ?3
        WHERE provider = 'line' AND event_id = ?1
          AND line_delivery_state = 'reply_attempted'
          AND line_reply_attempts = 1
          AND line_delivery_attempt_id = ?2
        RETURNING event_id`,
  )
    .bind(eventId, replyAttemptId, new Date().toISOString())
    .first<{ event_id: string }>();
  return claimed !== null;
}

async function sendClaimedLinePush(
  environment: McpRuntimeEnv,
  target: string,
  response: string,
  eventId: string,
): Promise<boolean> {
  const claimed = await environment.DB.prepare(
    `UPDATE bot_events
        SET line_delivery_state = 'push_attempted', updated_at = ?2
      WHERE provider = 'line' AND event_id = ?1
        AND line_delivery_state IN ('push_pending', 'push_attempted')
      RETURNING event_id`,
  )
    .bind(eventId, new Date().toISOString())
    .first<{ event_id: string }>();
  if (claimed === null) return false;
  await sendLinePush(environment, target, response, eventId);
  await markLineDeliveryDelivered(environment.DB, eventId);
  return true;
}

async function markLineDeliveryDelivered(database: D1Database, eventId: string): Promise<void> {
  await database.prepare(
    `UPDATE bot_events
        SET line_delivery_state = 'delivered', line_delivery_attempt_id = NULL,
            updated_at = ?2
      WHERE provider = 'line' AND event_id = ?1
        AND line_delivery_state IN ('reply_attempted', 'push_attempted')`,
  )
    .bind(eventId, new Date().toISOString())
    .run();
}

async function markLineDeliveryPermanentFailure(
  database: D1Database,
  eventId: string,
  replyAttemptId: string,
): Promise<void> {
  await database.prepare(
    `UPDATE bot_events
        SET line_delivery_state = 'permanent_failure', line_delivery_attempt_id = NULL,
            updated_at = ?3
      WHERE provider = 'line' AND event_id = ?1
        AND line_delivery_state = 'reply_attempted'
        AND line_delivery_attempt_id = ?2`,
  )
    .bind(eventId, replyAttemptId, new Date().toISOString())
    .run();
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 2 ** Math.max(0, attempts) * 5);
}
