import { Container } from "@cloudflare/containers";

import type { McpRuntimeEnv } from "../mcp/types";

export interface DiscordContainerEnvironment extends McpRuntimeEnv {
  DISCORD_BOT_TOKEN: string;
}

export interface DiscordGatewaySession {
  resumeURL: string;
  sequence: number;
  sessionId: string;
  shardCount: number;
  shardId: number;
}

export class DiscordGatewayContainer extends Container<DiscordContainerEnvironment> {
  public override defaultPort = 8080;
  public override sleepAfter = "24h";
  public override enableInternet = true;

  public constructor(
    context: ConstructorParameters<
      typeof Container<DiscordContainerEnvironment>
    >[0],
    environment: DiscordContainerEnvironment,
  ) {
    super(context, environment);
    this.envVars = {
      DISCORD_BOT_TOKEN: environment.DISCORD_BOT_TOKEN,
      DISCORD_BRIDGE_SECRET: environment.DISCORD_BRIDGE_SECRET,
      WORKER_INTERNAL_URL: environment.WORKER_INTERNAL_URL,
      PORT: "8080",
    };
  }

  public override onActivityExpired(): Promise<void> {
    // Discord Gateway is intentionally always-on. Not stopping renews the
    // Container activity window, as documented by Cloudflare Containers.
    this.renewActivityTimeout();
    return Promise.resolve();
  }

  public getGatewaySession(shardId: number): Promise<DiscordGatewaySession | null> {
    return this.ctx.storage.get<DiscordGatewaySession>(sessionKey(shardId)).then(
      (value) => value ?? null,
    );
  }

  public async saveGatewaySession(
    shardId: number,
    session: DiscordGatewaySession | null,
  ): Promise<void> {
    if (session === null) {
      await this.ctx.storage.delete(sessionKey(shardId));
      return;
    }
    await this.ctx.storage.put(sessionKey(shardId), session);
  }
}

function sessionKey(shardId: number): string {
  return `discord:gateway-session:${String(shardId)}`;
}
