import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";

interface BridgeResponse {
  answer: string | null;
  duplicate?: boolean;
}

interface RuntimeConfiguration {
  discordToken: string;
  bridgeSecret: string;
  workerUrl: string;
  port: number;
}

export function normalizeMentionQuery(content: string, botUserId: string): string {
  return content
    .replaceAll(`<@${botUserId}>`, "")
    .replaceAll(`<@!${botUserId}>`, "")
    .trim();
}

export function splitDiscordMessage(content: string, limit = 1_900): string[] {
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const splitAt = boundary > limit / 2 ? boundary : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function runDiscordGateway(
  configuration = readConfiguration(),
): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  const healthServer = createServer((_request, response) => {
    response.writeHead(client.isReady() ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ready: client.isReady() }));
  });
  healthServer.listen(configuration.port, "0.0.0.0");

  client.once("ready", (readyClient) => {
    console.info("Discord gateway connected", { botUserId: readyClient.user.id });
  });
  client.on("messageCreate", (message) => {
    void handleMessage(client, message, configuration).catch((error: unknown) => {
      console.error("Discord message handling failed", {
        messageId: message.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    });
  });

  const shutdown = (): void => {
    void client.destroy();
    healthServer.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await client.login(configuration.discordToken);
}

async function handleMessage(
  client: Client,
  message: Message,
  configuration: RuntimeConfiguration,
): Promise<void> {
  if (message.author.bot || client.user === null) return;
  const isDirectMessage = message.guildId === null;
  if (!isDirectMessage && !message.mentions.users.has(client.user.id)) return;
  const query = normalizeMentionQuery(message.content, client.user.id);
  if (query.length === 0) return;
  if (!message.channel.isSendable()) return;

  await message.channel.sendTyping();
  const body = JSON.stringify({
    provider: "discord",
    eventId: message.id,
    externalUserId: message.author.id,
    externalChannelId: isDirectMessage ? null : message.channelId,
    query,
  });
  const response = await fetchBridgeWithRetry(
    new URL("/api/v1/internal/bot-query", configuration.workerUrl),
    body,
    configuration.bridgeSecret,
  );
  if (!response.ok) {
    throw new Error(`Wiki bridge failed with status ${String(response.status)}`);
  }
  const result = parseBridgeResponse(await response.json());
  if (result.answer === null) return;
  const [first, ...rest] = splitDiscordMessage(result.answer);
  if (first === undefined) return;
  await message.reply({ content: first, allowedMentions: { parse: [] } });
  for (const chunk of rest) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

export async function fetchBridgeWithRetry(
  url: URL,
  body: string,
  bridgeSecret: string,
  options: {
    timeoutMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  let lastError: unknown;
  while (Date.now() < deadline) {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac("sha256", bridgeSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nago-timestamp": timestamp,
          "x-nago-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(15_000, deadline - Date.now())),
        ),
      });
      if (response.status !== 202 && response.status < 500) return response;
      lastError = new Error(`Wiki bridge is not ready (${String(response.status)})`);
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null
        ? Number.NaN
        : Number(retryAfterHeader);
      const delayMs = Number.isFinite(retryAfter)
        ? Math.max(0, Math.min(5_000, retryAfter * 1_000))
        : 1_000;
      if (Date.now() + delayMs >= deadline) break;
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (Date.now() + 1_000 >= deadline) break;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Wiki bridge retry budget was exhausted");
}

function parseBridgeResponse(value: unknown): BridgeResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Wiki bridge returned an invalid response");
  }
  const answer = "answer" in value ? value.answer : null;
  const duplicate = "duplicate" in value ? value.duplicate : undefined;
  if (answer !== null && typeof answer !== "string") {
    throw new Error("Wiki bridge returned an invalid answer");
  }
  return {
    answer,
    ...(typeof duplicate === "boolean" ? { duplicate } : {}),
  };
}

function readConfiguration(): RuntimeConfiguration {
  return {
    discordToken: requiredEnvironment("DISCORD_BOT_TOKEN"),
    bridgeSecret: requiredEnvironment("DISCORD_BRIDGE_SECRET"),
    workerUrl: requiredEnvironment("WORKER_INTERNAL_URL"),
    port: Number(process.env.PORT ?? "8080"),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runDiscordGateway();
}
