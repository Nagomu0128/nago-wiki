import { describe, expect, it } from "vitest";

import {
  applyImportRequestSchema,
  createImportRequestSchema,
  importJobSchema,
} from "./portable-import";

describe("portable import contracts", () => {
  it("accepts a public URL without a client-controlled workspace", () => {
    expect(
      createImportRequestSchema.parse({
        sourceType: "url",
        sourceUrl: "https://example.com/notes",
      }),
    ).toEqual({ sourceType: "url", sourceUrl: "https://example.com/notes" });
  });

  it("rejects a client-controlled workspace", () => {
    expect(() =>
      createImportRequestSchema.parse({
        workspaceId: "other-workspace",
        sourceType: "google_docs",
        documentId: "document-1",
      }),
    ).toThrow();
  });

  it("bounds buffered PDF and paste payloads", () => {
    expect(() =>
      createImportRequestSchema.parse({
        sourceType: "pdf",
        filename: "large.pdf",
        content: "x".repeat(5 * 1024 * 1024 + 1),
      }),
    ).toThrow();
    expect(() =>
      createImportRequestSchema.parse({
        sourceType: "paste",
        content: "x".repeat(1 * 1024 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("keeps job and apply contracts aligned", () => {
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
      accessMode: "workspace",
      acceptedTags: ["knowledge"],
    });
  });
});
