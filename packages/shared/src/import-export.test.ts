import { describe, expect, it } from "vitest";

import {
  applyImportRequestSchema,
  createImportRequestSchema,
  importJobSchema,
} from "./import-export";

describe("portable import contracts", () => {
  it("accepts the web public request without a client workspace id", () => {
    expect(
      createImportRequestSchema.parse({
        sourceType: "url",
        sourceUrl: "https://example.com/notes",
      }),
    ).toEqual({
      sourceType: "url",
      sourceUrl: "https://example.com/notes",
    });
  });

  it("rejects a client-controlled workspace id", () => {
    expect(() =>
      createImportRequestSchema.parse({
        workspaceId: "other-workspace",
        sourceType: "google_docs",
        documentId: "document-1",
      }),
    ).toThrow();
  });

  it("keeps ImportJob and apply fields aligned with the web adapter", () => {
    expect(
      importJobSchema.parse({
        id: "import-1",
        sourceType: "markdown",
        sourceLabel: "notes.md",
        status: "preview_ready",
        previewMarkdown: "# Notes",
        warnings: [],
        suggestedTitle: "Notes",
        createdAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toMatchObject({ sourceLabel: "notes.md", warnings: [] });
    expect(
      applyImportRequestSchema.parse({
        parentId: null,
        title: "Notes",
        acceptedTags: ["knowledge"],
      }),
    ).toEqual({
      parentId: null,
      title: "Notes",
      acceptedTags: ["knowledge"],
    });
  });
});
