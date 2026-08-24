import { describe, expect, it } from "vitest";

import { accessProtectedApiPaths } from "../src/auth/protected-api-paths";

describe("Access-protected API paths", () => {
  it("protects both Google OAuth setup and Picker credentials", () => {
    expect(accessProtectedApiPaths).toContain("/api/v1/imports/google/authorize");
    expect(accessProtectedApiPaths).toContain("/api/v1/imports/google/picker-config");
  });
});
