import type { PageCursor } from "./repository";

export function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (cursor === undefined) return null;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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

export function encodeCursor(cursor: PageCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
