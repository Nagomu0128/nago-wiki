import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { D1SearchCandidateAuthorizer } from "./authorizer";
import { answerRequestSchema, searchRequestSchema } from "./contracts";
import { WikiAnswerService, WorkersAiAnswerModel } from "./answer-service";
import { WikiSearchService } from "./search-service";

interface AiApi {
  Bindings: Env;
  Variables: { userId: string };
}

export function createAiRoutes(): Hono<AiApi> {
  const routes = new Hono<AiApi>();

  routes.post("/search", zValidator("json", searchRequestSchema), async (context) => {
    const services = createServices(context.env);
    const result = await services.search.search(
      requireUserId(context.get("userId"), context.req.header("x-nago-user-id")),
      context.req.valid("json"),
    );
    return context.json(result);
  });

  routes.post("/answer", zValidator("json", answerRequestSchema), async (context) => {
    const services = createServices(context.env);
    const result = await services.answer.answer(
      requireUserId(context.get("userId"), context.req.header("x-nago-user-id")),
      context.req.valid("json"),
    );
    return context.json(result);
  });

  return routes;
}

function createServices(environment: Env): {
  search: WikiSearchService;
  answer: WikiAnswerService;
} {
  const publicOrigin = new URL(environment.MCP_PUBLIC_ORIGIN).origin;
  const authorizer = new D1SearchCandidateAuthorizer(environment.DB, publicOrigin);
  const search = new WikiSearchService(environment.WIKI_SEARCH, authorizer);
  const model = new WorkersAiAnswerModel(
    environment.AI,
    environment.ANSWER_MODEL,
    environment.AI_GATEWAY_ID,
  );
  return { search, answer: new WikiAnswerService(search, model) };
}

function requireUserId(contextUserId: string | undefined, headerUserId: string | undefined): string {
  const userId = contextUserId ?? headerUserId;
  if (userId === undefined || userId.length === 0) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return userId;
}
