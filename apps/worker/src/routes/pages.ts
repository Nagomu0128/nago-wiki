import {
  createCommentRequestSchema,
  createPageRequestSchema,
  movePageRequestSchema,
  restoreVersionRequestSchema,
  updatePageRequestSchema,
} from "@nago-wiki/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  coreErrorHandler,
  coreRequestContext,
  type CoreHonoEnv,
  requireIdentity,
} from "../core/context";
import { ApiProblem } from "../core/errors";
import {
  createD1WikiCoreService,
  type WikiCoreService,
} from "../core/page-service";

const pageIdSchema = z.uuid();
const MAX_JSON_BODY_BYTES = 1_100_000;

export interface PagesRoutesOptions {
  createService?: (environment: Env) => WikiCoreService;
}

export function createPagesRoutes(options: PagesRoutesOptions = {}) {
  const app = new Hono<CoreHonoEnv>();
  const createService = options.createService ?? createD1WikiCoreService;

  app.onError(coreErrorHandler);
  app.use("*", coreRequestContext);

  app.get("/tree", async (context) => {
    const pages = await createService(context.env).listTree(
      requireIdentity(context),
    );
    return context.json({ pages });
  });

  app.post("/pages", async (context) => {
    const request = await parseJsonBody(context, createPageRequestSchema);
    const idempotencyKey = parseIdempotencyKey(
      context.req.header("Idempotency-Key"),
    );
    const result = await createService(context.env).createPage(
      requireIdentity(context),
      request,
      idempotencyKey,
    );
    return context.json(result, 201);
  });

  app.get("/pages/:id", async (context) => {
    const pageId = parseId(context.req.param("id"));
    return context.json(
      await createService(context.env).getPage(requireIdentity(context), pageId),
    );
  });

  app.patch("/pages/:id", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const request = await parseJsonBody(context, updatePageRequestSchema);
    return context.json(
      await createService(context.env).updatePage(
        requireIdentity(context),
        pageId,
        request,
      ),
    );
  });

  app.post("/pages/:id/move", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const request = await parseJsonBody(context, movePageRequestSchema);
    return context.json(
      await createService(context.env).movePage(
        requireIdentity(context),
        pageId,
        request,
      ),
    );
  });

  app.delete("/pages/:id", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const pageIds = await createService(context.env).trashPage(
      requireIdentity(context),
      pageId,
    );
    return context.json({ status: "trashed" as const, pageIds });
  });

  app.post("/pages/:id/restore", async (context) => {
    const pageId = parseId(context.req.param("id"));
    return context.json(
      await createService(context.env).restorePage(
        requireIdentity(context),
        pageId,
      ),
    );
  });

  app.get("/pages/:id/versions", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const versions = await createService(context.env).listVersions(
      requireIdentity(context),
      pageId,
    );
    return context.json({ versions });
  });

  app.post(
    "/pages/:id/versions/:versionId/restore",
    async (context) => {
      const pageId = parseId(context.req.param("id"));
      const versionId = parseId(context.req.param("versionId"));
      const request = await parseJsonBody(context, restoreVersionRequestSchema);
      return context.json(
        await createService(context.env).restoreVersion(
          requireIdentity(context),
          pageId,
          versionId,
          request,
        ),
      );
    },
  );

  app.get("/pages/:id/comments", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const comments = await createService(context.env).listComments(
      requireIdentity(context),
      pageId,
    );
    return context.json({ comments });
  });

  app.post("/pages/:id/comments", async (context) => {
    const pageId = parseId(context.req.param("id"));
    const request = await parseJsonBody(context, createCommentRequestSchema);
    const comment = await createService(context.env).createComment(
      requireIdentity(context),
      pageId,
      request,
    );
    return context.json(comment, 201);
  });

  return app;
}

async function parseJsonBody<Schema extends z.ZodType>(
  context: Context<CoreHonoEnv>,
  schema: Schema,
): Promise<z.output<Schema>> {
  const contentLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new ApiProblem("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
  }

  let body: unknown;
  try {
    body = await readBoundedJson(context.req.raw, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new ApiProblem("INVALID_REQUEST", 400, "A valid JSON body is required");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiProblem("INVALID_REQUEST", 400, "Request validation failed", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  if (request.body === null) throw new Error("missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ApiProblem("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function parseId(value: string): string {
  const parsed = pageIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiProblem("PAGE_NOT_FOUND", 404, "Page was not found or is not visible");
  }
  return parsed.data;
}

function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      400,
      "Idempotency-Key must contain between 1 and 200 characters",
    );
  }
  return trimmed;
}
