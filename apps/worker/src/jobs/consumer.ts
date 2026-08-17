import { asyncJobSchema, type AsyncJob } from "./contracts";
import { indexPage } from "./index-page";
import { persistPageVersion } from "./persist-version";
import { answerBotQuery } from "../bots/service";
import { sendLineReply } from "../bots/line";
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
          issues: parsed.error.issues,
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
        await sendLineReply(
          environment,
          job.response.replyToken,
          response,
          job.externalChannelId ?? job.externalUserId,
        );
      }
      return;
    }
    case "persist-version":
      await persistPageVersion(environment.DB, environment.FILES, job);
  }
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 2 ** Math.max(0, attempts) * 5);
}
