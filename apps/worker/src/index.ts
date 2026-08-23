import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { createAiRoutes } from "./ai/routes";
import { createAccessAuthenticationMiddleware } from "./auth/access";
import { createBotRoutes } from "./bots/routes";
import { DiscordGatewayContainer } from "./bots/discord-container";
import { AuthorizationService, canEdit, canView } from "./core/authorization";
import {
  coreErrorHandler,
  coreRequestContext,
  requireIdentity,
  type CoreHonoEnv,
} from "./core/context";
import { createRealtimeWikiCoreService } from "./core/realtime-mutations";
import { D1WikiRepository } from "./core/repository";
import { consumeAsyncJobs } from "./jobs/consumer";
import { reconcilePendingJobs } from "./jobs/reconcile";
import { createExportRoutes } from "./exports/routes";
import {
  cleanupExpiredPortableExports,
  PORTABLE_EXPORT_CLEANUP_CRON,
  reconcileQueuedPortableExports,
  runWeeklyBackupMaintenance,
  WEEKLY_BACKUP_CRON,
} from "./exports/service";
import {
  cleanupExpiredImports,
  createImportRoutes,
  reconcileQueuedImports,
} from "./imports/routes";
import { createMcpOAuthProvider } from "./mcp/oauth";
import { isMcpOAuthPath } from "./mcp/security";
import type { McpRuntimeEnv } from "./mcp/types";
import { PageRoom } from "./realtime/page-room";
import { createRealtimeRoutes } from "./realtime/routes";
import { createPagesRoutes } from "./routes/pages";

export { DiscordGatewayContainer, PageRoom };
export { ExportWorkflow } from "./exports/workflow";
export { ImportWorkflow } from "./imports/workflow";

const app = new Hono<CoreHonoEnv>();
app.onError(coreErrorHandler);
app.use("/api/v1/*", coreRequestContext);

const accessAuthentication = createAccessAuthenticationMiddleware({
  resolveConfig: (environment) => ({
    audience: environment.ACCESS_AUDIENCE,
    issuer: environment.ACCESS_ISSUER,
    workspaceId: environment.WORKSPACE_ID,
    environment: environment.ENVIRONMENT,
    allowDevelopmentIdentity: parseBoolean(
      environment.ALLOW_DEVELOPMENT_IDENTITY,
    ),
  }),
});
const exposeIdentity: MiddlewareHandler<CoreHonoEnv> = async (
  context,
  next,
) => {
  context.set("userId", requireIdentity(context).id);
  await next();
};

for (const path of [
  "/api/v1/tree",
  "/api/v1/pages",
  "/api/v1/pages/*",
  "/api/v1/search",
  "/api/v1/answer",
  "/api/v1/imports",
  "/api/v1/imports/:id",
  "/api/v1/imports/:id/apply",
  "/api/v1/imports/google/authorize",
  "/api/v1/exports",
  "/api/v1/exports/*",
  "/api/v1/account-links",
]) {
  app.use(path, accessAuthentication, exposeIdentity);
}

app.route(
  "/",
  createRealtimeRoutes({
    authorize: async (_request, pageId, environment, identity) => {
      if (identity === undefined) return null;
      const permission = await new AuthorizationService(
        new D1WikiRepository(environment.DB),
      ).effectivePermission(identity, pageId);
      if (!canView(permission)) return null;
      return {
        workspaceId: identity.workspaceId,
        userId: identity.id,
        sessionId: crypto.randomUUID(),
        permission: canEdit(permission) ? "editor" : "viewer",
        expiresAt: identity.expiresAt * 1_000,
      };
    },
  }),
);
app.route(
  "/api/v1",
  createPagesRoutes({ createService: createRealtimeWikiCoreService }),
);
app.route("/api/v1", createAiRoutes());
app.route("/api/v1", createImportRoutes());
app.route("/api/v1", createExportRoutes());
app.route("/api/v1", createBotRoutes());

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
        requestId: context.get("requestId") ?? crypto.randomUUID(),
      },
    },
    404,
  ),
);

export default {
  fetch(request, environment, context) {
    const path = new URL(request.url).pathname;
    if (isMcpOAuthPath(path)) {
      return createMcpOAuthProvider(environment).fetch(
        request,
        environment,
        context,
      );
    }
    return app.fetch(request, environment, context);
  },
  queue: consumeAsyncJobs,
  scheduled(controller, environment, context) {
    const tasks: { name: string; promise: Promise<unknown> }[] = [
      {
        name: "job reconciliation",
        promise: reconcilePendingJobs(environment),
      },
      {
        name: "export Workflow reconciliation",
        promise: reconcileQueuedPortableExports(environment),
      },
      {
        name: "import Workflow reconciliation",
        promise: reconcileQueuedImports(environment),
      },
      {
        name: "Discord gateway",
        promise: environment.DISCORD_GATEWAY.getByName("gateway").start(),
      },
    ];
    if (controller.cron === WEEKLY_BACKUP_CRON) {
      tasks.push({
        name: "weekly portable backup",
        promise: runWeeklyBackupMaintenance(environment),
      });
    } else if (controller.cron === PORTABLE_EXPORT_CLEANUP_CRON) {
      tasks.push({
        name: "portable export cleanup",
        promise: cleanupExpiredPortableExports(environment),
      });
      tasks.push({
        name: "expired import cleanup",
        promise: cleanupExpiredImports(environment),
      });
    }
    context.waitUntil(
      Promise.allSettled(tasks.map((task) => task.promise)).then((results) => {
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            console.error(`Scheduled ${tasks[index]?.name ?? "task"} failed`, {
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Unknown error",
            });
          }
        }
      }),
    );
  },
} satisfies ExportedHandler<McpRuntimeEnv>;

function parseBoolean(value: string): boolean {
  return value === "true";
}
