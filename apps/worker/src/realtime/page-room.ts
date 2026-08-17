import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";

import { permissionTransition, verifyRealtimeAuthorization } from "./auth";
import {
  type CurrentBodyAdapter,
  D1CurrentBodyAdapter,
} from "./current-body";
import {
  encodeSyncStep1,
  encodeSyncUpdate,
  parseRealtimeMessage,
} from "./protocol";
import { PageRoomStorage } from "./storage";
import {
  REALTIME_AUTH_HEADER,
  REALTIME_SUBPROTOCOL,
  REALTIME_TEXT_KEY,
  type ConnectionAttachment,
  type RealtimeControlMessage,
  type RealtimePermission,
} from "./types";

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_INVALID_MESSAGE = 4400;
const MAX_MARKDOWN_BYTES = 1_048_576;
const MAX_REALTIME_UPDATE_BYTES = MAX_MARKDOWN_BYTES + 65_536;
const MAX_YDOC_STATE_BYTES = MAX_MARKDOWN_BYTES * 4;

export function validateRealtimeUpdate(
  document: Y.Doc,
  update: Uint8Array,
): void {
  if (update.byteLength > MAX_REALTIME_UPDATE_BYTES) {
    throw new Error("Realtime update exceeds the allowed size");
  }
  const candidate = new Y.Doc();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
  Y.applyUpdate(candidate, update);
  if (
    new TextEncoder().encode(candidate.getText(REALTIME_TEXT_KEY).toJSON())
      .byteLength > MAX_MARKDOWN_BYTES
  ) {
    throw new Error("Markdown exceeds the 1 MiB page limit");
  }
  if (Y.encodeStateAsUpdate(candidate).byteLength > MAX_YDOC_STATE_BYTES) {
    throw new Error("Realtime document state exceeds the allowed size");
  }
}

export interface PageRoomEnv {
  DB: D1Database;
  PAGE_ROOM: DurableObjectNamespace<PageRoom>;
  REALTIME_INTERNAL_SECRET: string;
  ASYNC_JOBS: Queue;
}

export interface ReplaceMarkdownInput {
  workspaceId: string;
  pageId: string;
  bodyMarkdown: string;
  requestedBy: string;
  expectedBaseRevision: number;
  reason?: "edit" | "restore" | "import" | "manual";
}

export type ReplaceMarkdownResult =
  | { ok: true; sequence: number; baseRevision: number }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
      dirty: boolean;
    };

export interface PageRoomPersistenceStatus {
  baseRevision: number;
  dirty: boolean;
  nextFlushAt: number | null;
}

export class PageRoom extends DurableObject<PageRoomEnv> {
  private readonly document = new Y.Doc();
  private readonly roomStorage: PageRoomStorage;
  private readonly currentBody: CurrentBodyAdapter;

  public constructor(ctx: DurableObjectState, env: PageRoomEnv) {
    super(ctx, env);
    this.roomStorage = new PageRoomStorage(ctx.storage);
    this.currentBody = this.createCurrentBodyAdapter(env.DB);

    void ctx.blockConcurrencyWhile(() => {
      this.roomStorage.initializeSchema();
      this.roomStorage.restoreInto(this.document);
      return Promise.resolve();
    });
  }

  protected createCurrentBodyAdapter(database: D1Database): CurrentBodyAdapter {
    return new D1CurrentBodyAdapter(database);
  }

  public override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    if (!hasSubprotocol(request, REALTIME_SUBPROTOCOL)) {
      return new Response(`Expected subprotocol ${REALTIME_SUBPROTOCOL}`, {
        status: 426,
      });
    }

    const signedAuthorization = request.headers.get(REALTIME_AUTH_HEADER);
    if (signedAuthorization === null) {
      return new Response("Not Found", { status: 404 });
    }
    const authorization = await verifyRealtimeAuthorization(
      signedAuthorization,
      this.env.REALTIME_INTERNAL_SECRET,
    );
    if (authorization === null) {
      return new Response("Not Found", { status: 404 });
    }
    if (
      !this.roomStorage.ensureIdentity(
        authorization.workspaceId,
        authorization.pageId,
      )
    ) {
      return new Response("Not Found", { status: 404 });
    }

    const initialized = await this.ensureInitialized(
      authorization.workspaceId,
      authorization.pageId,
    );
    if (!initialized) {
      return new Response("Not Found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      ...authorization,
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    sendControl(server, {
      type: "permission",
      permission: authorization.permission,
    });
    server.send(encodeSyncStep1(this.document));
    await this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL },
      webSocket: client,
    });
  }

  public override async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readAttachment(webSocket);
    if (attachment === null || attachment.expiresAt <= Date.now()) {
      sendControl(webSocket, {
        type: "error",
        code: "AUTH_EXPIRED",
        message: "The realtime session has expired",
      });
      webSocket.close(CLOSE_UNAUTHORIZED, "Session expired");
      return;
    }
    if (typeof message === "string") {
      sendControl(webSocket, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Client messages must use the binary sync protocol",
      });
      webSocket.close(CLOSE_INVALID_MESSAGE, "Binary messages required");
      return;
    }
    if (message.byteLength > MAX_REALTIME_UPDATE_BYTES + 32) {
      sendControl(webSocket, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Realtime update exceeds the allowed size",
      });
      webSocket.close(CLOSE_INVALID_MESSAGE, "Update too large");
      return;
    }

    try {
      const parsed = parseRealtimeMessage(
        message,
        this.document,
        attachment.permission === "editor",
      );
      if (parsed.kind === "reply") {
        webSocket.send(parsed.reply);
        return;
      }
      if (parsed.kind === "read-only") {
        sendControl(webSocket, {
          type: "error",
          code: "READ_ONLY",
          message: "This connection is read-only",
        });
        return;
      }
      if (parsed.kind === "unsupported") {
        sendControl(webSocket, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Unsupported realtime protocol message",
        });
        return;
      }

      try {
        validateRealtimeUpdate(this.document, parsed.update);
      } catch (error) {
        sendControl(webSocket, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: error instanceof Error ? error.message : "Update is too large",
        });
        webSocket.close(CLOSE_INVALID_MESSAGE, "Update rejected");
        return;
      }

      const persisted = this.roomStorage.persistUpdate(
        parsed.update,
        Date.now(),
        attachment.userId,
      );
      Y.applyUpdate(this.document, parsed.update, webSocket);
      await this.scheduleNextAlarm(persisted.nextFlushAt);
      this.broadcastBinary(parsed.broadcast, webSocket);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "realtime_invalid_message",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      sendControl(webSocket, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Malformed realtime protocol message",
      });
    }
  }

  public override async webSocketClose(): Promise<void> {
    await this.scheduleNextAlarm();
  }

  public override async webSocketError(
    webSocket: WebSocket,
    error: unknown,
  ): Promise<void> {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "realtime_websocket_error",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    try {
      webSocket.close(1011, "WebSocket error");
    } finally {
      await this.scheduleNextAlarm();
    }
  }

  public override async alarm(): Promise<void> {
    const now = Date.now();
    this.closeExpiredConnections(now);
    const meta = this.roomStorage.getMeta();

    if (
      meta.dirty &&
      meta.nextFlushAt !== null &&
      meta.nextFlushAt <= now
    ) {
      await this.flushCurrentBody(now);
    }
    await this.scheduleNextAlarm();
  }

  public async replaceMarkdown(
    input: ReplaceMarkdownInput,
  ): Promise<ReplaceMarkdownResult> {
    if (
      input.workspaceId.length === 0 ||
      input.pageId.length === 0 ||
      input.requestedBy.length === 0
    ) {
      throw new Error("workspaceId, pageId, and requestedBy are required");
    }
    if (
      new TextEncoder().encode(input.bodyMarkdown).byteLength >
      MAX_MARKDOWN_BYTES
    ) {
      throw new Error("Markdown exceeds the 1 MiB page limit");
    }
    if (!this.roomStorage.ensureIdentity(input.workspaceId, input.pageId)) {
      throw new Error("PageRoom identity does not match the requested page");
    }
    if (!(await this.ensureInitialized(input.workspaceId, input.pageId))) {
      throw new Error("Page does not exist");
    }
    const meta = this.roomStorage.getMeta();
    if (
      meta.dirty ||
      meta.baseRevision !== input.expectedBaseRevision
    ) {
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: meta.baseRevision,
        dirty: meta.dirty,
      };
    }

    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(this.document));
    const stateVector = Y.encodeStateVector(this.document);
    const text = clone.getText(REALTIME_TEXT_KEY);
    clone.transact(() => {
      text.delete(0, text.length);
      text.insert(0, input.bodyMarkdown);
    }, input.requestedBy);
    const update = Y.encodeStateAsUpdate(clone, stateVector);
    const persisted = this.roomStorage.persistUpdate(
      update,
      Date.now(),
      input.requestedBy,
      input.reason ?? "edit",
    );
    Y.applyUpdate(this.document, update, input.requestedBy);
    await this.scheduleNextAlarm(persisted.nextFlushAt);
    this.broadcastBinaryUpdate(update);
    return {
      ok: true,
      sequence: persisted.sequence,
      baseRevision: meta.baseRevision,
    };
  }

  public async flushNow(): Promise<PageRoomPersistenceStatus> {
    await this.flushCurrentBody(Date.now());
    await this.scheduleNextAlarm();
    return this.getPersistenceStatus();
  }

  public getPersistenceStatus(): PageRoomPersistenceStatus {
    const meta = this.roomStorage.getMeta();
    return {
      baseRevision: meta.baseRevision,
      dirty: meta.dirty,
      nextFlushAt: meta.nextFlushAt,
    };
  }

  public async reauthorizeUser(
    userId: string,
    nextPermission: RealtimePermission | null,
    expiresAt?: number,
  ): Promise<number> {
    let affected = 0;
    const transition = permissionTransition(nextPermission);
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(webSocket);
      if (attachment?.userId !== userId) {
        continue;
      }
      affected += 1;
      if (transition.action === "close") {
        sendControl(webSocket, {
          type: "error",
          code: "FORBIDDEN",
          message: "Access to this page was revoked",
        });
        webSocket.close(CLOSE_FORBIDDEN, "Access revoked");
        continue;
      }

      const updated: ConnectionAttachment = {
        ...attachment,
        permission: transition.permission,
        expiresAt: expiresAt ?? attachment.expiresAt,
      };
      webSocket.serializeAttachment(updated);
      sendControl(webSocket, {
        type: "permission",
        permission: updated.permission,
      });
    }
    await this.scheduleNextAlarm();
    return affected;
  }

  private async ensureInitialized(
    workspaceId: string,
    pageId: string,
  ): Promise<boolean> {
    if (this.roomStorage.getMeta().initialized) {
      return true;
    }

    // D1 is external I/O. It intentionally runs outside blockConcurrencyWhile.
    const current = await this.currentBody.load(workspaceId, pageId);
    if (current === null) {
      return false;
    }
    this.roomStorage.initializeFromMarkdown(
      this.document,
      current.bodyMarkdown,
      current.revision,
      Date.now(),
    );
    return true;
  }

  private async flushCurrentBody(now: number): Promise<void> {
    const pending = this.roomStorage.prepareFlush(this.document);
    const meta = this.roomStorage.getMeta();
    if (
      pending === null ||
      meta.workspaceId === null ||
      meta.pageId === null
    ) {
      return;
    }

    try {
      const result = await this.currentBody.commit({
        workspaceId: meta.workspaceId,
        pageId: meta.pageId,
        bodyMarkdown: pending.bodyMarkdown,
        baseRevision: pending.baseRevision,
        committedAt: now,
        authorId: pending.authorId,
        reason: pending.reason,
      });
      if (result.ok) {
        this.roomStorage.completeFlush(pending, result.revision, now);
        await Promise.all([
          this.env.ASYNC_JOBS.send({
            type: "persist-version",
            jobId: crypto.randomUUID(),
            versionId: result.versionId,
          }),
          this.env.ASYNC_JOBS.send({
            type: "index-page",
            jobId: crypto.randomUUID(),
            workspaceId: meta.workspaceId,
            pageId: meta.pageId,
            desiredHash: result.contentHash,
          }),
        ]);
      } else {
        this.roomStorage.recordConflict(result.currentRevision, now);
      }
    } catch (error) {
      this.roomStorage.recordFlushFailure(now);
      console.error(
        JSON.stringify({
          level: "error",
          event: "realtime_snapshot_commit_failed",
          workspaceId: meta.workspaceId,
          pageId: meta.pageId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  private closeExpiredConnections(now: number): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(webSocket);
      if (attachment === null || attachment.expiresAt <= now) {
        sendControl(webSocket, {
          type: "error",
          code: "AUTH_EXPIRED",
          message: "The realtime session has expired",
        });
        webSocket.close(CLOSE_UNAUTHORIZED, "Session expired");
      }
    }
  }

  private async scheduleNextAlarm(preferredFlushAt?: number): Promise<void> {
    const meta = this.roomStorage.getMeta();
    let nextAt = preferredFlushAt ?? meta.nextFlushAt;
    const now = Date.now();
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(webSocket);
      if (attachment !== null && attachment.expiresAt > now) {
        nextAt = nextAt === null
          ? attachment.expiresAt
          : Math.min(nextAt, attachment.expiresAt);
      }
    }

    if (nextAt === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(nextAt, now));
    }
  }

  private broadcastBinary(message: Uint8Array, sender?: WebSocket): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      if (webSocket !== sender) {
        try {
          webSocket.send(message);
        } catch {
          webSocket.close(1011, "Broadcast failed");
        }
      }
    }
  }

  private broadcastBinaryUpdate(update: Uint8Array): void {
    this.broadcastBinary(encodeSyncUpdate(update));
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

function readAttachment(webSocket: WebSocket): ConnectionAttachment | null {
  const value: unknown = webSocket.deserializeAttachment();
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<ConnectionAttachment>;
  if (
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.pageId !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    (candidate.permission !== "viewer" && candidate.permission !== "editor") ||
    typeof candidate.expiresAt !== "number" ||
    typeof candidate.issuedAt !== "number" ||
    typeof candidate.connectedAt !== "number"
  ) {
    return null;
  }
  return candidate as ConnectionAttachment;
}

function sendControl(
  webSocket: WebSocket,
  message: RealtimeControlMessage,
): void {
  try {
    webSocket.send(JSON.stringify(message));
  } catch {
    webSocket.close(1011, "Control message failed");
  }
}
