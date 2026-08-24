export function extractGoogleDocumentId(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname === "docs.google.com") {
      const match = /^\/document\/d\/([^/]+)/u.exec(url.pathname);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  } catch {
    // A raw document ID is also accepted.
  }
  return trimmed;
}
