import { describe, expect, it } from "vitest";

import {
  permissionTransition,
  signRealtimeAuthorization,
  verifyRealtimeAuthorization,
} from "../src/realtime/auth";
import type { RealtimeAuthorization } from "../src/realtime/types";

const SECRET = "test-secret-that-is-at-least-thirty-two-characters";
const NOW = 10_000;

function authorization(
  overrides: Partial<RealtimeAuthorization> = {},
): RealtimeAuthorization {
  return {
    workspaceId: "workspace-1",
    pageId: "page-1",
    userId: "user-1",
    sessionId: "session-1",
    permission: "editor",
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

describe("realtime internal authorization", () => {
  it("round-trips an HMAC-signed context", async () => {
    const expected = authorization();
    const token = await signRealtimeAuthorization(expected, SECRET);
    await expect(
      verifyRealtimeAuthorization(token, SECRET, NOW),
    ).resolves.toEqual(expected);
  });

  it("rejects tampered and expired contexts", async () => {
    const token = await signRealtimeAuthorization(authorization(), SECRET);
    await expect(
      verifyRealtimeAuthorization(token.replace("v1.", "v1.A"), SECRET, NOW),
    ).resolves.toBeNull();

    const expired = await signRealtimeAuthorization(
      authorization({ expiresAt: NOW }),
      SECRET,
    );
    await expect(
      verifyRealtimeAuthorization(expired, SECRET, NOW),
    ).resolves.toBeNull();
  });

  it("models viewer downgrade and access revocation separately", () => {
    expect(permissionTransition("viewer")).toEqual({
      action: "keep",
      permission: "viewer",
    });
    expect(permissionTransition(null)).toEqual({ action: "close" });
  });
});
