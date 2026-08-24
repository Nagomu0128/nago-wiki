import { describe, expect, it, vi } from "vitest";

import { createRealtimeRoutes } from "../src/realtime/routes";
import type { RealtimeRouteEnv } from "../src/realtime/routes";

const websocketHeaders = {
  upgrade: "websocket",
  "sec-websocket-protocol": "nago-yjs-v1",
};

describe("realtime route origin policy", () => {
  it("rejects foreign and missing origins before page authorization", async () => {
    const authorize = vi.fn(() => Promise.resolve(null));
    const routes = createRealtimeRoutes({
      authorize,
      publicOrigin: (environment) => environment.MCP_PUBLIC_ORIGIN,
    });
    const environment = {
      MCP_PUBLIC_ORIGIN: "https://wiki.example",
    } as RealtimeRouteEnv;

    const foreign = await routes.request(
      "https://wiki.example/api/v1/pages/page-1/realtime",
      { headers: { ...websocketHeaders, origin: "https://evil.example" } },
      environment,
    );
    const missing = await routes.request(
      "https://wiki.example/api/v1/pages/page-1/realtime",
      { headers: websocketHeaders },
      environment,
    );

    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("allows the configured origin to reach page authorization", async () => {
    const authorize = vi.fn(() => Promise.resolve(null));
    const routes = createRealtimeRoutes({
      authorize,
      publicOrigin: (environment) => environment.MCP_PUBLIC_ORIGIN,
    });

    const response = await routes.request(
      "https://wiki.example/api/v1/pages/page-1/realtime",
      { headers: { ...websocketHeaders, origin: "https://wiki.example" } },
      { MCP_PUBLIC_ORIGIN: "https://wiki.example" },
    );

    expect(response.status).toBe(404);
    expect(authorize).toHaveBeenCalledOnce();
  });
});
