import { describe, expect, it } from "vitest";
import { encodeSyncMessage, isTerminalCloseCode } from "./provider";

describe("realtime wire helpers", () => {
  it("encodes a one MiB update without spreading it onto the call stack", () => {
    const payload = new Uint8Array(1_048_576);
    payload[0] = 17;
    payload[payload.length - 1] = 29;

    const encoded = encodeSyncMessage(2, payload);

    expect(encoded.byteLength).toBeGreaterThan(payload.byteLength);
    expect(encoded.at(-1)).toBe(29);
  });

  it("does not retry terminal authentication and protocol close codes", () => {
    expect([1000, 4400, 4401, 4403].every(isTerminalCloseCode)).toBe(true);
    expect(isTerminalCloseCode(1012)).toBe(false);
  });
});
