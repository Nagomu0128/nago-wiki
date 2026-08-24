import { decryptJson, encryptJson } from "../imports/token-vault";
import type { PageCursor } from "./repository";

export interface PaginationCursorContext {
  userId: string;
  workspaceId: string;
  collection: "children" | "backlinks";
  targetPageId: string | null;
}

export async function decodeCursor(
  cursor: string | undefined,
  encryptionKey: string,
  context: PaginationCursorContext,
): Promise<PageCursor | null> {
  if (cursor === undefined) return null;
  try {
    const value: unknown = await decryptJson(
      cursor,
      encryptionKey,
      associatedData(context),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("sortTitle" in value) ||
      !("id" in value) ||
      typeof value.sortTitle !== "string" ||
      typeof value.id !== "string" ||
      value.sortTitle.length > 500 ||
      value.id.length === 0 ||
      value.id.length > 128
    ) {
      return null;
    }
    return { sortTitle: value.sortTitle, id: value.id };
  } catch {
    return null;
  }
}

export function encodeCursor(
  cursor: PageCursor,
  encryptionKey: string,
  context: PaginationCursorContext,
): Promise<string> {
  return encryptJson(cursor, encryptionKey, associatedData(context));
}

function associatedData(context: PaginationCursorContext): string {
  return JSON.stringify([
    "mcp-pagination-v1",
    context.userId,
    context.workspaceId,
    context.collection,
    context.targetPageId,
  ]);
}
