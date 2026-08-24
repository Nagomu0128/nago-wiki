import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { REST } from "@discordjs/rest";
import {
  WebSocketManager,
  WebSocketShardEvents,
  type SessionInfo,
} from "@discordjs/ws";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  Routes,
  type GatewayMessageCreateDispatchData,
} from "discord-api-types/v10";

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

export interface DiscordSessionStore {
  get(shardId: number): Promise<SessionInfo | null>;
  put(shardId: number, session: SessionInfo | null): Promise<void>;
}

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class RemoteDiscordSessionStore implements DiscordSessionStore {
  public constructor(
    private readonly workerUrl: string,
    private readonly bridgeSecret: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async get(shardId: number): Promise<SessionInfo | null> {
    const response = await this.request(shardId, "GET", "");
    if (!response.ok) {
      throw new Error(`Discord session load failed with status ${String(response.status)}`);
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || !("session" in value)) {
      throw new Error("Discord session store returned an invalid response");
    }
    if (value.session === null) return null;
    if (!isSessionInfo(value.session) || value.session.shardId !== shardId) {
      throw new Error("Discord session store returned an invalid session");
    }
    return value.session;
  }

  public async put(shardId: number, session: SessionInfo | null): Promise<void> {
    if (session !== null && session.shardId !== shardId) {
      throw new Error("Discord session shard does not match the storage key");
    }
    const body = JSON.stringify({ session });
    const response = await this.request(shardId, "PUT", body);
    if (!response.ok) {
      throw new Error(`Discord session save failed with status ${String(response.status)}`);
    }
  }

  private request(shardId: number, method: "GET" | "PUT", body: string) {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac("sha256", this.bridgeSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    return this.fetchImplementation(
      new URL(
        `/api/v1/internal/discord-session/${encodeURIComponent(String(shardId))}`,
        this.workerUrl,
      ),
      {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-nago-timestamp": timestamp,
          "x-nago-signature": signature,
        },
        ...(method === "PUT" ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      },
    );
  }
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
  sessionStore: DiscordSessionStore = new RemoteDiscordSessionStore(
    configuration.workerUrl,
    configuration.bridgeSecret,
  ),
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(configuration.discordToken);
  const manager = new WebSocketManager({
    token: configuration.discordToken,
    rest,
    intents:
      GatewayIntentBits.Guilds
      | GatewayIntentBits.GuildMessages
      | GatewayIntentBits.DirectMessages
      | GatewayIntentBits.MessageContent,
    retrieveSessionInfo: (shardId) => sessionStore.get(shardId),
    updateSessionInfo: (shardId, session) => sessionStore.put(shardId, session),
  });
  let ready = false;
  let botUserId: string | null = null;
  const healthServer = createServer((_request, response) => {
    response.writeHead(ready ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ready }));
  });
  healthServer.listen(configuration.port, "0.0.0.0");

  manager.on(WebSocketShardEvents.Ready, (data, shardId) => {
    ready = true;
    botUserId = data.user.id;
    console.info("Discord gateway connected", { botUserId, shardId });
  });
  manager.on(WebSocketShardEvents.Resumed, (shardId) => {
    ready = true;
    console.info("Discord gateway session resumed", { shardId });
  });
  manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
    ready = false;
    console.warn("Discord gateway disconnected", { code, shardId });
  });
  manager.on(WebSocketShardEvents.Error, (error, shardId) => {
    ready = false;
    console.error("Discord gateway error", {
      shardId,
      error: error.message,
    });
  });
  manager.on(WebSocketShardEvents.Dispatch, (data) => {
    if (data.t !== GatewayDispatchEvents.MessageCreate || botUserId === null) return;
    const message: GatewayMessageCreateDispatchData = data.d;
    void handleMessage(rest, message, botUserId, configuration).catch(
      (error: unknown) => {
        console.error("Discord message handling failed", {
          messageId: message.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      },
    );
  });

  const shutdown = (): void => {
    void manager.destroy();
    healthServer.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await manager.connect();
}

async function handleMessage(
  rest: REST,
  message: GatewayMessageCreateDispatchData,
  botUserId: string,
  configuration: RuntimeConfiguration,
): Promise<void> {
  if (message.author.bot === true) return;
  const isDirectMessage = message.guild_id === undefined;
  if (!isDirectMessage && !message.mentions.some((user) => user.id === botUserId)) return;
  const query = normalizeMentionQuery(message.content, botUserId);
  if (query.length === 0) return;

  await rest.post(Routes.channelTyping(message.channel_id));
  const body = JSON.stringify({
    provider: "discord",
    eventId: message.id,
    externalUserId: message.author.id,
    externalChannelId: isDirectMessage ? null : message.channel_id,
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
  const chunks = splitDiscordMessage(result.answer);
  for (const [index, chunk] of chunks.entries()) {
    await sendDiscordMessage(
      rest,
      message.channel_id,
      chunk,
      message.id,
      index,
      index === 0 ? message.id : undefined,
    );
  }
}

async function sendDiscordMessage(
  rest: REST,
  channelId: string,
  content: string,
  eventId: string,
  chunkIndex: number,
  replyTo?: string,
): Promise<void> {
  await rest.post(Routes.channelMessages(channelId), {
    body: {
      content,
      allowed_mentions: { parse: [] },
      nonce: discordMessageNonce(eventId, chunkIndex),
      enforce_nonce: true,
      ...(replyTo === undefined
        ? {}
        : {
            message_reference: {
              message_id: replyTo,
              fail_if_not_exists: false,
            },
          }),
    },
  });
}

export function discordMessageNonce(eventId: string, chunkIndex: number): string {
  return `${eventId.slice(-20)}:${String(chunkIndex)}`;
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

function isSessionInfo(value: unknown): value is SessionInfo {
  return isRecord(value)
    && typeof value.resumeURL === "string"
    && value.resumeURL.startsWith("wss://")
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.shardCount === "number"
    && Number.isSafeInteger(value.shardCount)
    && value.shardCount > 0
    && typeof value.shardId === "number"
    && Number.isSafeInteger(value.shardId)
    && value.shardId >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
