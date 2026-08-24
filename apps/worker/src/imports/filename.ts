export function safeImportFilename(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const leaf = normalized.split(/[\\/]/u).at(-1) ?? "document";
  const safe = leaf
    // Input filenames are untrusted and must drop ASCII control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^\p{L}\p{N}._()\- ]/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 255);
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : "document";
}
