const forbiddenFilenameCharacters = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);

export function safeImportFilename(
  value: string,
  fallback = "imported-document",
): string {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || forbiddenFilenameCharacters.has(character)
      ? "-"
      : character;
  })
    .join("")
    .replace(/^\.+/u, "")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 255) : fallback;
}
