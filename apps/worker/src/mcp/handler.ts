import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";

import { createWikiMcpServer } from "./server";
import { hasWikiReadScope } from "./security";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

export class McpApiHandler extends WorkerEntrypoint<McpRuntimeEnv, McpAuthProps> {
  public override fetch(request: Request): Promise<Response> {
    if (!hasWikiReadScope(this.ctx.props.scopes)) {
      return Promise.resolve(new Response("Missing wiki:read scope", { status: 403 }));
    }
    const handler = createMcpHandler(
      () => createWikiMcpServer(this.env, this.ctx.props),
      {
        route: "/mcp",
        corsOptions: false,
        legacy: "stateless",
      },
    );
    return handler(request, this.env, this.ctx);
  }
}
