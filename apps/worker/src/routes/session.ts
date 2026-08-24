import { Hono } from "hono";

import { requireIdentity, type CoreHonoEnv } from "../core/context";
import { ApiProblem } from "../core/errors";

interface WorkspaceRow {
  id: string;
  name: string;
}

export function createSessionRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();
  routes.get("/me", async (context) => {
    const identity = requireIdentity(context);
    const workspace = await context.env.DB.prepare(
      `SELECT id, name FROM workspaces WHERE id = ?1`,
    )
      .bind(identity.workspaceId)
      .first<WorkspaceRow>();
    if (workspace === null) {
      throw new ApiProblem("INTERNAL_ERROR", 500, "Workspace was not found");
    }
    return context.json({
      user: {
        id: identity.id,
        displayName: identity.displayName,
        email: identity.email,
        role: identity.role,
      },
      workspace: { id: workspace.id, name: workspace.name },
      features: {
        aiAnswer: true,
        googleImport: true,
        realtime: true,
      },
      budget: {
        state: "normal" as const,
        usedPercent: 0,
      },
    });
  });
  return routes;
}
