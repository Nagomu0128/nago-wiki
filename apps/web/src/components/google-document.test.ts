import { describe, expect, it } from "vitest";

import { extractGoogleDocumentId } from "./google-document";

describe("extractGoogleDocumentId", () => {
  it("extracts an ID from a Google Docs URL", () => {
    expect(extractGoogleDocumentId(
      "https://docs.google.com/document/d/document-123/edit?tab=t.0",
    )).toBe("document-123");
  });

  it("preserves a raw document ID", () => {
    expect(extractGoogleDocumentId("  document-123  ")).toBe("document-123");
  });
});
