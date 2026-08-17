import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import {
  importWorkflowSourceSchema,
  type ImportWorkflowSource,
} from "./contracts";
import { safeImportFilename } from "./filename";
import { fetchGoogleDocument } from "./google-client";
import { googleDocumentToMarkdown } from "./google-docs-parser";
import { fetchPublicDocument } from "./public-url";
import type { McpRuntimeEnv } from "../mcp/types";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1_048_576;

const importWorkflowParamsSchema = z.object({
  importId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedBy: z.string().min(1),
  source: importWorkflowSourceSchema,
});
export type ImportWorkflowParams = z.infer<typeof importWorkflowParamsSchema>;

interface SourceStepResult {
  sourceKey: string;
  sourceType: ImportWorkflowSource["sourceType"];
  title: string;
  filename: string;
  contentType: string;
  resolvedSourceUrl: string | null;
}

interface PreviewStepResult {
  previewKey: string;
  reportKey: string;
  title: string;
  warnings: number;
}

interface ConversionResult {
  markdown: string;
  title: string;
  warnings: string[];
  details: Record<string, unknown>;
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

      const source = await step.do("materialize import source", async () =>
        materializeSource(this.env, parameters),
      );

      const preview = await step.do("convert document preview", async () => {
        const object = await this.env.FILES.get(source.sourceKey);
        if (object === null || object.size > MAX_SOURCE_BYTES) {
          throw new Error("Stored import source is unavailable or too large");
        }
        const conversion = await convertSource(this.env.AI, object, source);
        if (new TextEncoder().encode(conversion.markdown).byteLength > MAX_PREVIEW_BYTES) {
          throw new Error("Converted Markdown exceeds the 1 MiB page limit");
        }
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
              sourceType: source.sourceType,
              resolvedSourceUrl: source.resolvedSourceUrl,
              warnings: conversion.warnings,
              ...conversion.details,
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
        const expiresAt = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1_000,
        ).toISOString();
        await this.env.DB.prepare(
          `UPDATE imports
              SET status = 'preview_ready',
                  report_r2_key = ?2,
                  source_metadata_json = json_set(
                    source_metadata_json,
                    '$.sourceKey', ?3,
                    '$.previewKey', ?4,
                    '$.title', ?5,
                    '$.warningCount', ?6,
                    '$.resolvedSourceUrl', ?7
                  ),
                  expires_at = ?8,
                  updated_at = ?9
            WHERE id = ?1`,
        )
          .bind(
            parameters.importId,
            preview.reportKey,
            source.sourceKey,
            preview.previewKey,
            preview.title,
            preview.warnings,
            source.resolvedSourceUrl,
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

async function materializeSource(
  environment: McpRuntimeEnv,
  parameters: ImportWorkflowParams,
): Promise<SourceStepResult> {
  const source = parameters.source;
  if (source.sourceType === "google_docs") {
    const document = await fetchGoogleDocument(
      environment,
      parameters.requestedBy,
      source.documentId,
    );
    const raw = JSON.stringify(document);
    if (new TextEncoder().encode(raw).byteLength > MAX_SOURCE_BYTES) {
      throw new Error("Google document exceeds the 20 MiB import limit");
    }
    const title = documentTitle(document);
    const sourceKey = `imports/${parameters.workspaceId}/${parameters.importId}/source/document.json`;
    await environment.FILES.put(sourceKey, raw, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        import_id: parameters.importId,
        source_type: source.sourceType,
      },
    });
    return {
      sourceKey,
      sourceType: source.sourceType,
      title,
      filename: "document.json",
      contentType: "application/json",
      resolvedSourceUrl: null,
    };
  }
  if (source.sourceType === "public_url") {
    const fetched = await fetchPublicDocument(source.sourceUrl);
    const sourceKey = `imports/${parameters.workspaceId}/${parameters.importId}/source/${safeImportFilename(fetched.filename)}`;
    await environment.FILES.put(sourceKey, fetched.bytes, {
      httpMetadata: { contentType: fetched.contentType },
      customMetadata: {
        import_id: parameters.importId,
        source_type: source.sourceType,
      },
    });
    return {
      sourceKey,
      sourceType: source.sourceType,
      title: titleFromFilename(fetched.filename),
      filename: fetched.filename,
      contentType: fetched.contentType,
      resolvedSourceUrl: fetched.finalUrl,
    };
  }
  if (!source.sourceKey.startsWith(`imports/${parameters.workspaceId}/${parameters.importId}/`)) {
    throw new Error("Stored import source key does not belong to this import");
  }
  const object = await environment.FILES.head(source.sourceKey);
  if (object === null || object.size > MAX_SOURCE_BYTES) {
    throw new Error("Stored import source is unavailable or too large");
  }
  return {
    sourceKey: source.sourceKey,
    sourceType: source.sourceType,
    title: titleFromFilename(source.filename),
    filename: source.filename,
    contentType: source.contentType,
    resolvedSourceUrl: null,
  };
}

async function convertSource(
  ai: Ai,
  object: R2ObjectBody,
  source: SourceStepResult,
): Promise<ConversionResult> {
  if (source.sourceType === "google_docs") {
    const conversion = googleDocumentToMarkdown(await object.json());
    return {
      markdown: conversion.markdown,
      title: conversion.title || source.title,
      warnings: conversion.warnings,
      details: { inlineObjectIds: conversion.inlineObjectIds },
    };
  }
  const normalizedType = source.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedType === "text/markdown" || normalizedType === "text/plain") {
    return {
      markdown: await object.text(),
      title: source.title,
      warnings: [],
      details: {},
    };
  }
  if (normalizedType !== "application/pdf" && normalizedType !== "text/html") {
    throw new Error("Import source content type is not supported");
  }
  const result = await ai.toMarkdown({
    name: source.filename,
    blob: await object.blob(),
  });
  if (result.format === "error") {
    throw new Error(`Markdown conversion failed: ${result.error}`);
  }
  return {
    markdown: result.data,
    title: source.title,
    warnings: [],
    details: {
      detectedMimeType: result.mimeType,
      estimatedTokens: result.tokens,
    },
  };
}

function documentTitle(document: unknown): string {
  if (typeof document !== "object" || document === null || !("title" in document)) {
    return "Imported Google Document";
  }
  return typeof document.title === "string" ? document.title : "Imported Google Document";
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension.length > 0 ? withoutExtension.slice(0, 500) : "Imported Document";
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Import failed";
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 1_000);
}
