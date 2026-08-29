import { asyncJobSchema, type AsyncJob } from "./contracts";
import { indexPage } from "./index-page";
import { persistPageVersion } from "./persist-version";
import { answerBotQuery } from "../bots/service";
import {
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
  if (now < delivery.replyExpiresAt) {
    try {
      await sendLineReply(environment, delivery.replyToken, response);
      return;
    } catch (error) {
      if (!(error instanceof LineReplyUnavailableError)) throw error;
      console.info("LINE reply unavailable; using push fallback", {
        jobId: job.jobId,
        eventId: job.eventId,
        reason: error.reason,
      });
    }
  } else {
    console.info("LINE reply token expired; using push fallback", {
      jobId: job.jobId,
      eventId: job.eventId,
      reason: "expired",
    });
  }
  await sendLinePush(environment, target, response, job.eventId);
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 2 ** Math.max(0, attempts) * 5);
}
