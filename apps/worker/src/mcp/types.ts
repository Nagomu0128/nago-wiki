import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface McpAuthProps {
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "editor" | "viewer";
  scopes: string[];
}

export interface McpRuntimeEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  DISCORD_BRIDGE_SECRET: string;
}
