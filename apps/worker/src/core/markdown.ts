export const MAX_PAGE_BODY_BYTES = 1_048_576;

export async function hashMarkdown(bodyMd: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bodyMd),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertMarkdownSize(bodyMd: string): void {
  const byteLength = new TextEncoder().encode(bodyMd).byteLength;
  if (byteLength > MAX_PAGE_BODY_BYTES) {
    throw new Error("PAGE_BODY_TOO_LARGE");
  }
}

export function normalizeSlug(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .trim()
    .replace(/[^\p{Letter}\p{Number}._~-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return normalized.length === 0 ? "untitled" : normalized;
}
