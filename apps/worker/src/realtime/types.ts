export const REALTIME_SUBPROTOCOL = "nago-yjs-v1";
export const REALTIME_AUTH_HEADER = "x-nago-realtime-context";
export const REALTIME_TEXT_KEY = "markdown";

export type RealtimePermission = "viewer" | "editor";

export interface RealtimeAuthorization {
  workspaceId: string;
  pageId: string;
  userId: string;
  sessionId: string;
  permission: RealtimePermission;
  expiresAt: number;
  issuedAt: number;
}

export interface ConnectionAttachment extends RealtimeAuthorization {
  connectedAt: number;
}

export type RealtimeControlMessage =
  | {
      type: "permission";
      permission: RealtimePermission;
    }
  | {
      type: "error";
      code:
        | "AUTH_EXPIRED"
        | "FORBIDDEN"
        | "INVALID_MESSAGE"
        | "READ_ONLY";
      message: string;
    };

export function isRealtimePermission(
  value: unknown,
): value is RealtimePermission {
  return value === "viewer" || value === "editor";
}

export function pageRoomKey(workspaceId: string, pageId: string): string {
  if (
    workspaceId.length === 0 ||
    pageId.length === 0 ||
    workspaceId.includes(":") ||
    pageId.includes(":")
  ) {
    throw new Error("workspaceId and pageId must be non-empty colon-free IDs");
  }

  return `${workspaceId}:${pageId}`;
}
