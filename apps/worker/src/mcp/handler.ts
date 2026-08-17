import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";

import { createWikiMcpServer } from "./server";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

export class McpApiHandler extends WorkerEntrypoint<McpRuntimeEnv, McpAuthProps> {
  public override fetch(request: Request): Promise<Response> {
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
