export function safeImportFilename(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const leaf = normalized.split(/[\\/]/u).at(-1) ?? "document";
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^\p{L}\p{N}._()\- ]/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 255);
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : "document";
}
