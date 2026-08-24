import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { CoreHonoEnv } from "../src/core/context";
import { DEFAULT_WORKSPACE_ID } from "../src/core/repository";
import { createSessionRoutes } from "../src/routes/session";

const identity: AuthenticatedIdentity = {
  id: "00000000-0000-7000-8000-000000000010",
  workspaceId: DEFAULT_WORKSPACE_ID,
  email: "editor@example.com",
  displayName: "Editor",
  role: "editor",
  status: "active",
  subject: "access-subject",
  expiresAt: 2_000_000_000,
};

describe("session route", () => {
  it("returns the authenticated member and workspace capabilities", async () => {
    const app = new Hono<CoreHonoEnv>();
    app.use("*", async (context, next) => {
      context.set("identity", identity);
      await next();
    });
    app.route("/api/v1", createSessionRoutes());

    const response = await app.request(
      "https://wiki.example/api/v1/me",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { id: identity.id, role: "editor" },
      workspace: { id: DEFAULT_WORKSPACE_ID, name: "Nago Wiki" },
      features: { aiAnswer: true, googleImport: true, realtime: true },
    });
  });
});
