import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";

import { createWikiMcpServer } from "./server";
import { hasWikiReadScope } from "./security";
import type { McpAuthProps, McpRuntimeEnv } from "./types";

export class McpApiHandler extends WorkerEntrypoint<McpRuntimeEnv, McpAuthProps> {
  public override async fetch(request: Request): Promise<Response> {
    if (!hasWikiReadScope(this.ctx.props.scopes)) {
      return new Response("MCP authorization is no longer valid", { status: 403 });
    }
    const currentAuth = await resolveCurrentMcpAuth(
      this.env.DB,
      this.env.WORKSPACE_ID,
      this.ctx.props,
    );
    if (currentAuth === null) {
      return new Response("MCP authorization is no longer valid", { status: 403 });
    }
    const handler = createMcpHandler(
      () => createWikiMcpServer(this.env, currentAuth),
      {
        route: "/mcp",
        corsOptions: false,
        legacy: "stateless",
      },
    );
    return handler(request, this.env, this.ctx);
  }
}

interface CurrentMcpMemberRow {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: McpAuthProps["role"];
}

export async function resolveCurrentMcpAuth(
  database: D1Database,
  configuredWorkspaceId: string,
  tokenProps: McpAuthProps,
): Promise<McpAuthProps | null> {
  if (tokenProps.workspaceId !== configuredWorkspaceId) return null;

  const member = await database
    .prepare(
      `SELECT id, workspace_id, email, display_name, role
         FROM users
        WHERE id = ?1
          AND workspace_id = ?2
          AND status = 'active'`,
    )
    .bind(tokenProps.userId, configuredWorkspaceId)
    .first<CurrentMcpMemberRow>();
  if (member === null) return null;

  return {
    userId: member.id,
    workspaceId: member.workspace_id,
    email: member.email,
    displayName: member.display_name,
    role: member.role,
    scopes: [...tokenProps.scopes],
  };
}
