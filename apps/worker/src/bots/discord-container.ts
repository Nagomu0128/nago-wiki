import { Container } from "@cloudflare/containers";

import type { McpRuntimeEnv } from "../mcp/types";

export interface DiscordContainerEnvironment extends McpRuntimeEnv {
  DISCORD_BOT_TOKEN: string;
  WORKER_INTERNAL_URL: string;
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
}
