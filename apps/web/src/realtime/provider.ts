import * as Y from "yjs";
import type { PagePermission } from "../api";

export type RealtimeStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export interface RealtimeSession {
  readonly document: Y.Doc;
  readonly status: RealtimeStatus;
  readonly permission: PagePermission;
  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void;
  subscribePermission(listener: (permission: PagePermission) => void): () => void;
  destroy(): void;
}

export interface RealtimeProviderFactory {
  connect(input: { pageId: string; document: Y.Doc; permission: PagePermission }): RealtimeSession;
}

const remoteOrigin = Symbol("nago-remote-update");

function writeVarUint(value: number, target: number[]) {
  let remaining = value;
  while (remaining > 127) {
    target.push((remaining & 127) | 128);
    remaining >>>= 7;
  }
  target.push(remaining & 127);
}

function writeBytes(value: Uint8Array, target: number[]) {
  writeVarUint(value.byteLength, target);
  target.push(...value);
}

function encodeSyncMessage(syncType: 0 | 1 | 2, payload: Uint8Array) {
  const target: number[] = [];
  writeVarUint(0, target);
  writeVarUint(syncType, target);
  writeBytes(payload, target);
  return new Uint8Array(target);
}

function readVarUint(data: Uint8Array, cursor: { value: number }) {
  let result = 0;
  let shift = 0;
  while (cursor.value < data.byteLength) {
    const current = data[cursor.value++];
    if (current === undefined) throw new Error("Unexpected end of realtime message.");
    result |= (current & 127) << shift;
    if ((current & 128) === 0) return result >>> 0;
    shift += 7;
    if (shift > 35) throw new Error("Invalid realtime varUint.");
  }
  throw new Error("Unexpected end of realtime message.");
}

function readBytes(data: Uint8Array, cursor: { value: number }) {
  const length = readVarUint(data, cursor);
  const end = cursor.value + length;
  if (end > data.byteLength) throw new Error("Invalid realtime byte payload.");
  const value = data.slice(cursor.value, end);
  cursor.value = end;
  return value;
}

interface ControlMessage {
  type: "permission" | "error";
  permission?: PagePermission;
  code?: string;
}

export class NativeYjsRealtimeSession implements RealtimeSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private readonly permissionListeners = new Set<(permission: PagePermission) => void>();
  private currentStatus: RealtimeStatus = "connecting";
  private currentPermission: PagePermission;

  constructor(
    private readonly url: string,
    public readonly document: Y.Doc,
    permission: PagePermission,
  ) {
    this.currentPermission = permission;
    this.document.on("update", this.handleDocumentUpdate);
    this.open();
  }

  get status() { return this.currentStatus; }
  get permission() { return this.currentPermission; }

  subscribeStatus(listener: (status: RealtimeStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => { this.statusListeners.delete(listener); };
  }

  subscribePermission(listener: (permission: PagePermission) => void) {
    this.permissionListeners.add(listener);
    listener(this.currentPermission);
    return () => { this.permissionListeners.delete(listener); };
  }

  destroy() {
    this.destroyed = true;
    this.document.off("update", this.handleDocumentUpdate);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "page changed");
    this.socket = null;
    this.setStatus("disconnected");
  }

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin || this.currentPermission === "viewer") return;
    this.send(encodeSyncMessage(2, update));
  };

  private open() {
    if (this.destroyed) return;
    this.setStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.url, "nago-yjs-v1");
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.send(encodeSyncMessage(0, Y.encodeStateVector(this.document)));
    });
    socket.addEventListener("message", (event) => { void this.handleMessage(event.data); });
    socket.addEventListener("error", () => { this.setStatus("error"); });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.destroyed || event.code === 1000) return;
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private async handleMessage(raw: unknown) {
    if (typeof raw === "string") {
      this.handleControlMessage(raw);
      return;
    }
    const bytes = raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Blob
        ? new Uint8Array(await raw.arrayBuffer())
        : null;
    if (!bytes) return;
    try {
      const cursor = { value: 0 };
      if (readVarUint(bytes, cursor) !== 0) return;
      const syncType = readVarUint(bytes, cursor);
      const payload = readBytes(bytes, cursor);
      if (syncType === 0) {
        if (this.currentPermission !== "viewer") this.send(encodeSyncMessage(1, Y.encodeStateAsUpdate(this.document, payload)));
      } else if (syncType === 1 || syncType === 2) {
        Y.applyUpdate(this.document, payload, remoteOrigin);
      }
    } catch {
      this.setStatus("error");
    }
  }

  private handleControlMessage(raw: string) {
    try {
      const message = JSON.parse(raw) as ControlMessage;
      if (message.type === "permission" && message.permission) {
        const permission = message.permission;
        this.currentPermission = permission;
        this.permissionListeners.forEach((listener) => { listener(permission); });
      }
      if (message.type === "error") this.setStatus("error");
    } catch {
      this.setStatus("error");
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.reconnectAttempt, 5)) + Math.random() * 300;
    this.reconnectTimer = window.setTimeout(() => { this.open(); }, delay);
  }

  private send(message: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      const copy = new Uint8Array(message.byteLength);
      copy.set(message);
      this.socket.send(copy.buffer);
    }
  }

  private setStatus(status: RealtimeStatus) {
    this.currentStatus = status;
    this.statusListeners.forEach((listener) => { listener(status); });
  }
}

export class NativeYjsRealtimeProviderFactory implements RealtimeProviderFactory {
  constructor(private readonly baseUrl = "/api/v1") {}

  connect({ pageId, document, permission }: { pageId: string; document: Y.Doc; permission: PagePermission }) {
    const endpoint = new URL(`${this.baseUrl}/pages/${encodeURIComponent(pageId)}/realtime`, window.location.origin);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return new NativeYjsRealtimeSession(endpoint.href, document, permission);
  }
}
