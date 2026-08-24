import type {
  AuthenticatedIdentity,
  Comment,
  CreatePageRequest,
  Page,
  PageTreeNode,
  PageVersion,
  PageWithPermission,
  UpdatePageRequest,
} from "@nago-wiki/shared";
import { apiErrorSchema } from "@nago-wiki/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CoreHonoEnv } from "../src/core/context";
import { ApiProblem } from "../src/core/errors";
import type { WikiCoreService } from "../src/core/page-service";
import { createPagesRoutes } from "../src/routes/pages";

const userId = "00000000-0000-7000-8000-000000000010";
const pageId = "00000000-0000-7000-8000-000000000020";
const identity: AuthenticatedIdentity = {
  id: userId,
  workspaceId: "00000000-0000-7000-8000-000000000001",
  email: "editor@example.com",
  displayName: "Editor",
  role: "editor",
  status: "active",
  subject: "access-subject",
  expiresAt: 2_000_000_000,
};
const page: Page = {
  id: pageId,
  workspaceId: identity.workspaceId,
  parentId: null,
  slug: "test",
  title: "Test",
  bodyMd: "before",
  revision: 1,
  contentHash: "0".repeat(64),
  accessMode: "workspace",
  status: "active",
  createdBy: userId,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  trashedAt: null,
};

class FakeWikiService implements WikiCoreService {
  public createIdempotencyKey: string | undefined;
  public updateRequest: UpdatePageRequest | undefined;
  public updateError: ApiProblem | undefined;

  public getPage(): Promise<PageWithPermission> {
    return Promise.resolve(pageResponse());
  }

  public createPage(
    identity: AuthenticatedIdentity,
    request: CreatePageRequest,
    idempotencyKey?: string,
  ): Promise<PageWithPermission> {
    void identity;
    void request;
    this.createIdempotencyKey = idempotencyKey;
    return Promise.resolve(pageResponse());
  }

  public updatePage(
    _identity: AuthenticatedIdentity,
    _pageId: string,
    request: UpdatePageRequest,
  ): Promise<PageWithPermission> {
    this.updateRequest = request;
    return this.updateError === undefined
      ? Promise.resolve(pageResponse())
      : Promise.reject(this.updateError);
  }

  public movePage(): Promise<PageWithPermission> {
    return Promise.resolve(pageResponse());
  }

  public trashPage(): Promise<string[]> {
    return Promise.resolve([pageId]);
  }

  public restorePage(): Promise<PageWithPermission> {
    return Promise.resolve(pageResponse());
  }

  public listTree(): Promise<PageTreeNode[]> {
    return Promise.resolve([]);
  }

  public listVersions(): Promise<PageVersion[]> {
    return Promise.resolve([]);
  }

  public restoreVersion(): Promise<PageWithPermission> {
    return Promise.resolve(pageResponse());
  }

  public listComments(): Promise<Comment[]> {
    return Promise.resolve([]);
  }

  public createComment(): Promise<Comment> {
    return Promise.reject(new Error("not used by this test"));
  }
}

describe("page routes", () => {
  it("forwards a valid page creation idempotency key", async () => {
    const service = new FakeWikiService();
    const response = await testApp(service).request(
      "https://wiki.example/api/v1/pages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "create-home",
        },
        body: JSON.stringify({ title: "Home" }),
      },
    );

    expect(response.status).toBe(201);
    expect(service.createIdempotencyKey).toBe("create-home");
  });

  it("requires baseRevision and returns structured validation errors", async () => {
    const service = new FakeWikiService();
    const response = await testApp(service).request(
      `https://wiki.example/api/v1/pages/${pageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyMd: "changed" }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-Id")).toMatch(/^req_/);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "INVALID_REQUEST",
    );
  });

  it("passes an optimistic update to the injected mutation service", async () => {
    const service = new FakeWikiService();
    const response = await testApp(service).request(
      `https://wiki.example/api/v1/pages/${pageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, bodyMd: "changed" }),
      },
    );

    expect(response.status).toBe(200);
    expect(service.updateRequest).toMatchObject({
      baseRevision: 1,
      bodyMd: "changed",
    });
  });

  it("serializes revision conflicts with the request id", async () => {
    const service = new FakeWikiService();
    service.updateError = new ApiProblem(
      "REVISION_CONFLICT",
      409,
      "The page changed",
      { currentRevision: 2 },
    );
    const response = await testApp(service).request(
      `https://wiki.example/api/v1/pages/${pageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, bodyMd: "changed" }),
      },
    );
    const error = apiErrorSchema.parse(await response.json());

    expect(response.status).toBe(409);
    expect(error.error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { currentRevision: 2 },
    });
    expect(error.error.requestId).toBe(response.headers.get("X-Request-Id"));
  });
});

function testApp(service: WikiCoreService): Hono<CoreHonoEnv> {
  const app = new Hono<CoreHonoEnv>();
  app.use("*", async (context, next) => {
    context.set("identity", identity);
    await next();
  });
  app.route(
    "/api/v1",
    createPagesRoutes({ createService: () => service }),
  );
  return app;
}

function pageResponse(): PageWithPermission {
  return { page, permission: "editor", tags: [] };
}
