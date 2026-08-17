import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  hasWikiReadScope,
  isMcpOAuthPath,
} from "../../src/mcp/security";

describe("MCP security boundaries", () => {
  it("escapes dynamic OAuth client content before rendering consent", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
    );
  });

  it("requires the read scope for every MCP request", () => {
    expect(hasWikiReadScope(["wiki:read"])).toBe(true);
    expect(hasWikiReadScope([])).toBe(false);
    expect(hasWikiReadScope(["profile"])).toBe(false);
  });

  it("routes only MCP and OAuth endpoints through the OAuth provider", () => {
    expect(isMcpOAuthPath("/mcp")).toBe(true);
    expect(isMcpOAuthPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isMcpOAuthPath("/oauth/token")).toBe(true);
    expect(isMcpOAuthPath("/api/v1/pages")).toBe(false);
    expect(isMcpOAuthPath("/mcp-unprotected")).toBe(false);
  });
});
