import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import type { Context } from "hono";
import type { ErrorHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiProblem, toApiErrorBody } from "./errors";

export interface CoreVariables {
  identity: AuthenticatedIdentity | undefined;
  requestId: string | undefined;
}

export interface CoreHonoEnv {
  Bindings: Env;
  Variables: CoreVariables;
}

export const coreRequestContext = createMiddleware<CoreHonoEnv>(
  async (context, next) => {
    const requestId = context.get("requestId") ?? `req_${crypto.randomUUID()}`;
    context.set("requestId", requestId);
    await next();
    context.header("X-Request-Id", requestId);
  },
);

export const coreErrorHandler: ErrorHandler<CoreHonoEnv> = (error, context) => {
  const requestId = context.get("requestId") ?? `req_${crypto.randomUUID()}`;
  const problem =
    error instanceof ApiProblem
      ? error
      : new ApiProblem(
          "INTERNAL_ERROR",
          500,
          "An unexpected error occurred",
        );

  if (!(error instanceof ApiProblem)) {
    console.error(
      JSON.stringify({
        message: "unhandled request error",
        requestId,
        path: new URL(context.req.url).pathname,
        error: error.message,
      }),
    );
  }
  context.header("X-Request-Id", requestId);
  return context.json(
    toApiErrorBody(problem, requestId),
    problem.status as ContentfulStatusCode,
  );
};

export function requireIdentity(
  context: Context<CoreHonoEnv>,
): AuthenticatedIdentity {
  const identity = context.get("identity");
  if (identity === undefined) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      401,
      "Authentication is required",
    );
  }
  return identity;
}
