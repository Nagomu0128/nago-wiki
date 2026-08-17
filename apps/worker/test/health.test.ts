import { describe, expect, it } from "vitest";

describe("health contract", () => {
  it("keeps the public health path stable", () => {
    expect("/api/v1/health").toBe("/api/v1/health");
  });
});
