import { describe, expect, it } from "vitest";

import {
  assertGooglePreviewSize,
  boundedGoogleWarnings,
} from "../../src/imports/workflow";

describe("Google import preview bounds", () => {
  it("rejects converted markdown larger than the page storage limit", () => {
    expect(() => {
      assertGooglePreviewSize("x".repeat(1_048_577));
    }).toThrow(
      "1 MiB page limit",
    );
  });

  it("deduplicates, truncates, and caps report warnings", () => {
    const warnings = boundedGoogleWarnings([
      "duplicate",
      "duplicate",
      ...Array.from({ length: 150 }, (_, index) => `${String(index)}:${"x".repeat(1_100)}`),
    ]);
    expect(warnings).toHaveLength(100);
    expect(warnings[0]).toBe("duplicate");
    expect(warnings.every((warning) => warning.length <= 1_000)).toBe(true);
  });
});
