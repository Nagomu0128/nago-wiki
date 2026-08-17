import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import { fetchGoogleDocument } from "./google-client";
import { googleDocumentToMarkdown } from "./google-docs-parser";
import type { McpRuntimeEnv } from "../mcp/types";

const importWorkflowParamsSchema = z.object({
  importId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedBy: z.string().min(1),
  source: z.object({
    type: z.literal("google_docs"),
    documentId: z.string().min(1).max(256),
  }),
});
export type ImportWorkflowParams = z.infer<typeof importWorkflowParamsSchema>;

interface SourceStepResult {
  sourceKey: string;
  title: string;
}

interface PreviewStepResult {
  previewKey: string;
  reportKey: string;
  title: string;
  warnings: number;
}

export class ImportWorkflow extends WorkflowEntrypoint<
  McpRuntimeEnv,
  ImportWorkflowParams
> {
  public override async run(
    event: Readonly<WorkflowEvent<ImportWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<PreviewStepResult> {
    const parameters = importWorkflowParamsSchema.parse(event.payload);
    try {
      await step.do("mark import running", async () => {
        await this.env.DB.prepare(
          `UPDATE imports SET status = 'running', updated_at = ?2 WHERE id = ?1`,
        )
          .bind(parameters.importId, new Date().toISOString())
          .run();
        return { status: "running" as const };
      });

      const source = await step.do("fetch Google document", async () => {
        const document = await fetchGoogleDocument(
          this.env,
          parameters.requestedBy,
          parameters.source.documentId,
        );
        const raw = JSON.stringify(document);
        if (new TextEncoder().encode(raw).byteLength > 20 * 1024 * 1024) {
          throw new Error("Google document exceeds the 20 MiB import limit");
        }
        const title = documentTitle(document);
        const sourceKey = `imports/${parameters.workspaceId}/${parameters.importId}/source/document.json`;
        await this.env.FILES.put(sourceKey, raw, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          customMetadata: {
            import_id: parameters.importId,
            source_type: "google_docs",
          },
        });
        return { sourceKey, title } satisfies SourceStepResult;
      });

      const preview = await step.do("convert document preview", async () => {
        const object = await this.env.FILES.get(source.sourceKey);
        if (object === null) throw new Error("Stored import source was not found");
        const conversion = googleDocumentToMarkdown(await object.json());
        const previewKey = `imports/${parameters.workspaceId}/${parameters.importId}/preview.md`;
        const reportKey = `imports/${parameters.workspaceId}/${parameters.importId}/report.json`;
        await Promise.all([
          this.env.FILES.put(previewKey, conversion.markdown, {
            httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          }),
          this.env.FILES.put(
            reportKey,
            JSON.stringify({
              title: conversion.title,
              inlineObjectIds: conversion.inlineObjectIds,
              warnings: conversion.warnings,
            }),
            { httpMetadata: { contentType: "application/json; charset=utf-8" } },
          ),
        ]);
        return {
          previewKey,
          reportKey,
          title: conversion.title || source.title,
          warnings: conversion.warnings.length,
        } satisfies PreviewStepResult;
      });

      await step.do("publish import preview", async () => {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
        await this.env.DB.prepare(
          `UPDATE imports
              SET status = 'preview_ready',
                  report_r2_key = ?2,
                  source_metadata_json = json_set(
                    source_metadata_json,
                    '$.sourceKey', ?3,
                    '$.previewKey', ?4,
                    '$.title', ?5,
                    '$.warningCount', ?6
                  ),
                  expires_at = ?7,
                  updated_at = ?8
            WHERE id = ?1`,
        )
          .bind(
            parameters.importId,
            preview.reportKey,
            source.sourceKey,
            preview.previewKey,
            preview.title,
            preview.warnings,
            expiresAt,
            new Date().toISOString(),
          )
          .run();
        return { status: "preview_ready" as const };
      });
      return preview;
    } catch (error) {
      await step.do("mark import failed", async () => {
        await this.env.DB.prepare(
          `UPDATE imports
              SET status = 'failed',
                  source_metadata_json = json_set(source_metadata_json, '$.error', ?2),
                  updated_at = ?3
            WHERE id = ?1`,
        )
          .bind(
            parameters.importId,
            publicErrorMessage(error),
            new Date().toISOString(),
          )
          .run();
        return { status: "failed" as const };
      });
      throw error;
    }
  }
}

function documentTitle(document: unknown): string {
  if (typeof document !== "object" || document === null || !("title" in document)) {
    return "Imported Google Document";
  }
  return typeof document.title === "string" ? document.title : "Imported Google Document";
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Import failed";
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 1_000);
}
