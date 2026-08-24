import { Hono } from "hono";
import type { AuthenticatedIdentity } from "@nago-wiki/shared";

import { signRealtimeAuthorization } from "./auth";
import type { PageRoomEnv } from "./page-room";
import {
  REALTIME_AUTH_HEADER,
  REALTIME_SUBPROTOCOL,
  pageRoomKey,
  type RealtimePermission,
} from "./types";

export interface RealtimeRouteAuthorization {
  workspaceId: string;
  userId: string;
  sessionId: string;
  permission: RealtimePermission;
  expiresAt: number;
}

export interface RealtimeRoutesOptions {
  authorize: (
    request: Request,
    pageId: string,
    env: PageRoomEnv,
    identity: AuthenticatedIdentity | undefined,
  ) => Promise<RealtimeRouteAuthorization | null>;
  publicOrigin: (env: RealtimeRouteEnv) => string;
  now?: () => number;
}

export interface RealtimeRouteEnv extends PageRoomEnv {
  MCP_PUBLIC_ORIGIN: string;
}

interface RealtimeHonoEnv {
  Bindings: RealtimeRouteEnv;
  Variables: { identity: AuthenticatedIdentity | undefined };
}

export function createRealtimeRoutes(
  options: RealtimeRoutesOptions,
): Hono<RealtimeHonoEnv> {
  const routes = new Hono<RealtimeHonoEnv>();
  routes.get("/api/v1/pages/:pageId/realtime", async (context) => {
    const request = context.req.raw;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return context.text("Expected Upgrade: websocket", 426);
    }
    if (!hasSubprotocol(request, REALTIME_SUBPROTOCOL)) {
      return context.text(`Expected subprotocol ${REALTIME_SUBPROTOCOL}`, 426);
    }
    if (!isAllowedRealtimeOrigin(
      request.headers.get("origin"),
      options.publicOrigin(context.env),
    )) {
      return context.text("Forbidden", 403);
    }

    const pageId = context.req.param("pageId");
    const authorization = await options.authorize(
      request,
      pageId,
      context.env,
      context.get("identity"),
    );
    if (authorization === null) {
      return context.text("Not Found", 404);
    }

    const now = options.now?.() ?? Date.now();
    const signed = await signRealtimeAuthorization(
      {
        ...authorization,
        pageId,
        issuedAt: now,
      },
      context.env.REALTIME_INTERNAL_SECRET,
    );
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("cf-access-jwt-assertion");
    headers.set(REALTIME_AUTH_HEADER, signed);
    headers.set("sec-websocket-protocol", REALTIME_SUBPROTOCOL);

    const room = context.env.PAGE_ROOM.getByName(
      pageRoomKey(authorization.workspaceId, pageId),
    );
    return room.fetch(
      new Request(request.url, {
        method: "GET",
        headers,
      }),
    );
  });
  return routes;
}

export function isAllowedRealtimeOrigin(
  requestOrigin: string | null,
  publicOrigin: string,
): boolean {
  if (requestOrigin === null) return false;
  try {
    return new URL(requestOrigin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

function hasSubprotocol(request: Request, expected: string): boolean {
  return (
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .some((protocol) => protocol.trim() === expected) ?? false
  );
}
