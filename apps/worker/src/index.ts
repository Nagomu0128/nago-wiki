import { Hono } from "hono";

import { createAiRoutes } from "./ai/routes";
import { consumeAsyncJobs } from "./jobs/consumer";

export { ImportWorkflow } from "./imports/workflow";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/v1/ai", createAiRoutes());

app.get("/api/v1/health", (context) =>
  context.json({
    ok: true as const,
    service: "nago-wiki" as const,
    timestamp: new Date().toISOString(),
  }),
);

app.notFound((context) =>
  context.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found",
        requestId: context.get("requestId" as never) ?? crypto.randomUUID(),
      },
    },
    404,
  ),
);

export default {
  fetch: app.fetch,
  queue: consumeAsyncJobs,
} satisfies ExportedHandler<Env>;
