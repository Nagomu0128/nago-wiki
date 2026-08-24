import { describe, expect, it } from "vitest";

import { matchesMagicBytes, safeAssetFilename } from "../src/routes/assets";

describe("asset validation", () => {
  it("normalizes hostile paths and enforces the MIME extension", () => {
    expect(safeAssetFilename("../../設計 図.exe", ".png")).toBe("設計-図.exe.png");
  });

  it("sniffs supported image signatures instead of trusting Content-Type", () => {
    expect(matchesMagicBytes("image/png", new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))).toBe(true);
    expect(matchesMagicBytes("image/png", new TextEncoder().encode("<svg>"))).toBe(false);
    expect(matchesMagicBytes("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
  });
});
