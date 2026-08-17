export function isMcpOAuthPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path === "/authorize" ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/oauth-")
  );
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
