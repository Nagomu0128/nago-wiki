import { Hono } from "hono";

import { createAiRoutes } from "./ai/routes";
import { consumeAsyncJobs } from "./jobs/consumer";
import { createMcpOAuthProvider } from "./mcp/oauth";
import { isMcpOAuthPath } from "./mcp/security";
import type { McpRuntimeEnv } from "./mcp/types";

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
  fetch(request, environment, context) {
    const path = new URL(request.url).pathname;
    if (isMcpOAuthPath(path)) {
      return createMcpOAuthProvider(environment).fetch(request, environment, context);
    }
    return app.fetch(request, environment, context);
  },
  queue: consumeAsyncJobs,
} satisfies ExportedHandler<McpRuntimeEnv>;
