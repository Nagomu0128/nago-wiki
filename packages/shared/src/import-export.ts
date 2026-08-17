import { z } from "zod";

const filenameSchema = z.string().trim().min(1).max(255);

export const importSourceTypeSchema = z.enum([
  "google_docs",
  "markdown",
  "pdf",
  "url",
  "paste",
]);
export type ImportSourceType = z.infer<typeof importSourceTypeSchema>;

export const createImportRequestSchema = z.discriminatedUnion("sourceType", [
  z
    .object({
      sourceType: z.literal("google_docs"),
      documentId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("markdown"),
      filename: filenameSchema,
      content: z.string().min(1).max(1_048_576),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("pdf"),
      filename: filenameSchema,
      content: z.string().min(1).max(28 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("url"),
      sourceUrl: z.url().max(4_096),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("paste"),
      filename: filenameSchema.optional(),
      content: z.string().min(1).max(5 * 1024 * 1024),
    })
    .strict(),
]);
export type CreateImportRequest = z.infer<typeof createImportRequestSchema>;

export const importJobStatusSchema = z.enum([
  "queued",
  "running",
  "preview_ready",
  "applied",
  "failed",
]);
export const importJobSchema = z.object({
  id: z.string(),
  sourceType: importSourceTypeSchema,
  sourceLabel: z.string(),
  status: importJobStatusSchema,
  previewMarkdown: z.string().optional(),
  currentMarkdown: z.string().optional(),
  warnings: z.array(z.string()),
  suggestedTitle: z.string().optional(),
  suggestedTags: z.array(z.string()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      reauthUrl: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const applyImportRequestSchema = z.object({
  parentId: z.uuid().nullable(),
  title: z.string().trim().min(1).max(500),
  acceptedTags: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .optional()
    .default([]),
});
export type ApplyImportRequest = z.infer<typeof applyImportRequestSchema>;

export const exportJobStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);
export const exportJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: exportJobStatusSchema,
  pageCount: z.number().int().nonnegative(),
  archiveSize: z.number().int().nonnegative().nullable(),
  archiveHash: z.string().length(64).nullable(),
  error: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;
