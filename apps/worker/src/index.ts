import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { createAiRoutes } from "./ai/routes";
import { createAccessAuthenticationMiddleware } from "./auth/access";
import { accessProtectedApiPaths } from "./auth/protected-api-paths";
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
import { createImportRoutes } from "./imports/routes";
import { cleanupExpiredImports } from "./imports/cleanup";
import { createMcpOAuthProvider } from "./mcp/oauth";
import { isMcpOAuthPath } from "./mcp/security";
import type { McpRuntimeEnv } from "./mcp/types";
import { PageRoom } from "./realtime/page-room";
import { createRealtimeRoutes } from "./realtime/routes";
import { createAssetRoutes } from "./routes/assets";
import { createOrganizationRoutes } from "./routes/organization";
import { createPagesRoutes } from "./routes/pages";
import { createSessionRoutes } from "./routes/session";

export { DiscordGatewayContainer, PageRoom };
export { ImportWorkflow } from "./imports/workflow";

const app = new Hono<CoreHonoEnv>();
app.onError(coreErrorHandler);
app.use("/api/v1/*", coreRequestContext);

const accessAuthentication = createAccessAuthenticationMiddleware({
  resolveConfig: (environment) => ({
    audience: environment.ACCESS_AUDIENCE,
    issuer: environment.ACCESS_ISSUER,
    workspaceId: environment.WORKSPACE_ID,
    bootstrapOwnerEmail: environment.BOOTSTRAP_OWNER_EMAIL,
    environment: environment.ENVIRONMENT,
    allowDevelopmentIdentity: parseBoolean(environment.ALLOW_DEVELOPMENT_IDENTITY),
  }),
});
const exposeIdentity: MiddlewareHandler<CoreHonoEnv> = async (context, next) => {
  context.set("userId", requireIdentity(context).id);
  await next();
};

for (const path of accessProtectedApiPaths) {
  app.use(path, accessAuthentication, exposeIdentity);
}

app.route(
  "/",
  createRealtimeRoutes({
    publicOrigin: (environment) => environment.MCP_PUBLIC_ORIGIN,
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
app.route("/api/v1", createSessionRoutes());
app.route("/api/v1", createOrganizationRoutes());
app.route("/api/v1", createAssetRoutes());
app.route("/api/v1", createAiRoutes());
app.route("/api/v1", createImportRoutes());
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
      return createMcpOAuthProvider(environment).fetch(request, environment, context);
    }
    return app.fetch(request, environment, context);
  },
  queue: consumeAsyncJobs,
  scheduled(_controller, environment, context) {
    context.waitUntil(
      Promise.all([
        reconcilePendingJobs(environment),
        cleanupExpiredImports(environment),
        environment.DISCORD_GATEWAY.getByName("gateway").start(),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<McpRuntimeEnv>;

function parseBoolean(value: string): boolean {
  return value === "true";
}
