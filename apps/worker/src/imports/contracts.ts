import {
  createImportRequestSchema,
  type CreateImportRequest,
} from "@nago-wiki/shared";
import { z } from "zod";

export const createImportSchema = createImportRequestSchema;
export type { CreateImportRequest };

export const importWorkflowSourceSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("google_docs"),
    documentId: z.string().min(1).max(256),
  }),
  z.object({
    sourceType: z.enum(["markdown", "pdf", "paste"]),
    sourceKey: z.string().min(1).max(1_024),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
  }),
  z.object({
    sourceType: z.literal("public_url"),
    sourceUrl: z.url().max(4_096),
  }),
]);

export type ImportWorkflowSource = z.infer<typeof importWorkflowSourceSchema>;
