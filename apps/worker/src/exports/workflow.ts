import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import {
  buildCentralDirectory,
  buildStoredLocalRecord,
  crc32,
  localRecordLength,
  planStoredZip,
  type ZipArchivePlan,
} from "./zip";
import type { McpRuntimeEnv } from "../mcp/types";

const encoder = new TextEncoder();
const TARGET_PART_BYTES = 5 * 1024 * 1024;

const exportWorkflowParamsSchema = z.object({
  exportId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedBy: z.string().min(1),
});
export type ExportWorkflowParams = z.infer<typeof exportWorkflowParamsSchema>;

const exportPageSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  revision: z.number().int().positive(),
  contentHash: z.string().length(64),
  accessMode: z.enum(["workspace", "restricted"]),
  status: z.enum(["active", "trashed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  bodyBytes: z.number().int().nonnegative(),
  file: z.string(),
});
type ExportPage = z.infer<typeof exportPageSchema>;

const zipEntrySchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  localOffset: z.number().int().nonnegative(),
});
const storedPlanSchema = z.object({
  formatVersion: z.literal(1),
  exportId: z.string(),
  workspaceId: z.string(),
  exportedAt: z.string(),
  pages: z.array(exportPageSchema),
  zip: z.object({
    entries: z.array(zipEntrySchema),
    centralOffset: z.number().int().nonnegative(),
    centralSize: z.number().int().nonnegative(),
    archiveSize: z.number().int().nonnegative(),
  }),
  groups: z.array(
    z.object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    }),
  ),
});
type StoredExportPlan = z.infer<typeof storedPlanSchema>;

interface PageDescriptorRow {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  revision: number;
  content_hash: string;
  access_mode: "workspace" | "restricted";
  status: "active" | "trashed";
  created_at: string;
  updated_at: string;
  body_bytes: number;
}

interface PageBodyRow {
  id: string;
  revision: number;
  content_hash: string;
  body_md: string;
}

interface ExportDbRow {
  r2_key: string | null;
  multipart_upload_id: string | null;
}

interface PlanStepResult {
  planKey: string;
  archiveKey: string;
  archiveSize: number;
  pageCount: number;
  partCount: number;
}

interface UploadStepResult {
  uploadId: string;
}

interface PartStepResult {
  partNumber: number;
  etag: string;
  crc32: number[];
}

export class ExportWorkflow extends WorkflowEntrypoint<
  McpRuntimeEnv,
  ExportWorkflowParams
> {
  public override async run(
    event: Readonly<WorkflowEvent<ExportWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ archiveKey: string; archiveSize: number; pageCount: number }> {
    const parameters = exportWorkflowParamsSchema.parse(event.payload);
    let upload: UploadStepResult | undefined;
    try {
      await step.do("mark export running", async () => {
        await this.env.DB.prepare(
          `UPDATE exports SET status = 'running', updated_at = ?2 WHERE id = ?1`,
        )
          .bind(parameters.exportId, new Date().toISOString())
          .run();
        return { status: "running" as const };
      });

      const plan = await step.do("plan portable export", async () =>
        createAndStorePlan(this.env, parameters),
      );

      upload = await step.do("create archive multipart upload", async () =>
        createOrResumeUpload(this.env, parameters, plan),
      );
      const uploadId = upload.uploadId;

      const completedParts: PartStepResult[] = [];
      for (let index = 0; index < plan.partCount; index += 1) {
        const previousCrcs =
          index === plan.partCount - 1
            ? completedParts.flatMap((part) => part.crc32)
            : [];
        const part = await step.do(
          `write archive part ${String(index + 1).padStart(5, "0")}`,
          async () =>
            writeArchivePart(
              this.env,
              parameters,
              plan,
              uploadId,
              index,
              previousCrcs,
            ),
        );
        completedParts.push(part);
      }

      await step.do("complete portable export", async () => {
        const existing = await this.env.FILES.head(plan.archiveKey);
        const object =
          existing ??
          (await this.env.FILES.resumeMultipartUpload(
            plan.archiveKey,
            uploadId,
          ).complete(
            completedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
          ));
        if (object.size !== plan.archiveSize) {
          throw new Error("Completed export archive size does not match its plan");
        }
        const expiresAt = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1_000,
        ).toISOString();
        const now = new Date().toISOString();
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE exports
                SET status = 'ready', r2_key = ?2, archive_size = ?3,
                    multipart_upload_id = NULL, updated_at = ?4, expires_at = ?5
              WHERE id = ?1`,
          ).bind(parameters.exportId, plan.archiveKey, object.size, now, expiresAt),
          this.env.DB.prepare(
            `INSERT INTO audit_events (
               id, actor_id, action, target_type, target_id, metadata_json, created_at
             ) VALUES (?1, ?2, 'export.completed', 'export', ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING`,
          ).bind(
            parameters.exportId,
            parameters.requestedBy,
            parameters.exportId,
            JSON.stringify({
              archiveSize: object.size,
              pageCount: plan.pageCount,
            }),
            now,
          ),
        ]);
        return { status: "ready" as const };
      });
      return {
        archiveKey: plan.archiveKey,
        archiveSize: plan.archiveSize,
        pageCount: plan.pageCount,
      };
    } catch (error) {
      if (upload !== undefined) {
        await step.do("abort failed archive upload", async () => {
          const row = await this.env.DB.prepare(
            `SELECT r2_key, multipart_upload_id FROM exports WHERE id = ?1`,
          )
            .bind(parameters.exportId)
            .first<ExportDbRow>();
          if (row?.multipart_upload_id && row.r2_key) {
            const completed = await this.env.FILES.head(row.r2_key);
            if (completed === null) {
              await this.env.FILES.resumeMultipartUpload(
                row.r2_key,
                row.multipart_upload_id,
              ).abort();
            }
          }
          return { aborted: true as const };
        });
      }
      await step.do("mark export failed", async () => {
        await this.env.DB.prepare(
          `UPDATE exports
              SET status = 'failed', error_message = ?2,
                  multipart_upload_id = NULL, updated_at = ?3
            WHERE id = ?1`,
        )
          .bind(parameters.exportId, publicErrorMessage(error), new Date().toISOString())
          .run();
        return { status: "failed" as const };
      });
      throw error;
    }
  }
}

async function createAndStorePlan(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
): Promise<PlanStepResult> {
  const pages = await listExportPages(environment.DB, parameters.workspaceId);
  const exportedAt = new Date().toISOString();
  const manifest = buildManifest(parameters, exportedAt, pages);
  const zip = planStoredZip([
    ...pages.map((page) => ({ name: page.file, size: page.bodyBytes })),
    { name: "manifest.json", size: encoder.encode(manifest).byteLength },
  ]);
  const groups = groupEntries(zip);
  const storedPlan: StoredExportPlan = {
    formatVersion: 1,
    exportId: parameters.exportId,
    workspaceId: parameters.workspaceId,
    exportedAt,
    pages,
    zip,
    groups,
  };
  const planKey = `exports/${parameters.workspaceId}/${parameters.exportId}/plan.json`;
  const archiveKey = `exports/${parameters.workspaceId}/${parameters.exportId}/wiki-export.zip`;
  await environment.FILES.put(planKey, JSON.stringify(storedPlan), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { export_id: parameters.exportId, kind: "plan" },
  });
  await environment.DB.prepare(
    `UPDATE exports
        SET plan_r2_key = ?2, r2_key = ?3, page_count = ?4,
            archive_size = ?5, updated_at = ?6
      WHERE id = ?1`,
  )
    .bind(
      parameters.exportId,
      planKey,
      archiveKey,
      pages.length,
      zip.archiveSize,
      new Date().toISOString(),
    )
    .run();
  return {
    planKey,
    archiveKey,
    archiveSize: zip.archiveSize,
    pageCount: pages.length,
    partCount: groups.length,
  };
}

async function createOrResumeUpload(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
  plan: PlanStepResult,
): Promise<UploadStepResult> {
  const row = await environment.DB.prepare(
    `SELECT r2_key, multipart_upload_id FROM exports WHERE id = ?1`,
  )
    .bind(parameters.exportId)
    .first<ExportDbRow>();
  if (row?.r2_key === plan.archiveKey && row.multipart_upload_id !== null) {
    return { uploadId: row.multipart_upload_id };
  }
  const upload = await environment.FILES.createMultipartUpload(plan.archiveKey, {
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: `attachment; filename="nago-wiki-${parameters.exportId}.zip"`,
    },
    customMetadata: {
      export_id: parameters.exportId,
      workspace_id: parameters.workspaceId,
    },
  });
  await environment.DB.prepare(
    `UPDATE exports SET multipart_upload_id = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(parameters.exportId, upload.uploadId, new Date().toISOString())
    .run();
  return { uploadId: upload.uploadId };
}

async function writeArchivePart(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
  summary: PlanStepResult,
  uploadId: string,
  partIndex: number,
  previousCrcs: number[],
): Promise<PartStepResult> {
  const plan = await loadPlan(environment.FILES, summary.planKey);
  const group = plan.groups[partIndex];
  if (group === undefined) throw new Error("Export archive part is outside its plan");
  const pageIndexes = range(group.start, Math.min(group.end, plan.pages.length));
  const pageBodies = await loadPageBodies(
    environment.DB,
    parameters.workspaceId,
    pageIndexes.map((index) => requiredAt(plan.pages, index, "export page")),
  );
  const manifest = buildManifest(parameters, plan.exportedAt, plan.pages);
  const records: Uint8Array[] = [];
  const partCrcs: number[] = [];
  for (let index = group.start; index < group.end; index += 1) {
    const entry = requiredAt(plan.zip.entries, index, "ZIP entry");
    const data =
      index === plan.pages.length
        ? encoder.encode(manifest)
        : requirePageBytes(
            requiredAt(plan.pages, index, "export page"),
            pageBodies,
          );
    const checksum = crc32(data);
    partCrcs.push(checksum);
    records.push(buildStoredLocalRecord(entry, data, checksum));
  }
  if (partIndex === plan.groups.length - 1) {
    const allCrcs = [...previousCrcs, ...partCrcs];
    if (allCrcs.length !== plan.zip.entries.length) {
      throw new Error("Export archive CRC list is incomplete");
    }
    records.push(
      buildCentralDirectory(
        plan.zip,
        new Map(
          plan.zip.entries.map((entry, index) => [
            entry.name,
            requiredAt(allCrcs, index, "ZIP CRC"),
          ]),
        ),
      ),
    );
  }
  const body = concatenate(records);
  const uploaded = await environment.FILES.resumeMultipartUpload(
    summary.archiveKey,
    uploadId,
  ).uploadPart(partIndex + 1, body);
  return {
    partNumber: uploaded.partNumber,
    etag: uploaded.etag,
    crc32: partCrcs,
  };
}

async function listExportPages(
  database: D1Database,
  workspaceId: string,
): Promise<ExportPage[]> {
  const result: ExportPage[] = [];
  let cursor = "";
  let batchSize: number;
  do {
    const rows = await database
      .prepare(
        `SELECT id, parent_id, slug, title, revision, content_hash,
                access_mode, status, created_at, updated_at,
                length(CAST(body_md AS BLOB)) AS body_bytes
           FROM pages
          WHERE workspace_id = ?1 AND id > ?2
          ORDER BY id
          LIMIT 250`,
      )
      .bind(workspaceId, cursor)
      .all<PageDescriptorRow>();
    for (const row of rows.results) {
      result.push({
        id: row.id,
        parentId: row.parent_id,
        slug: row.slug,
        title: row.title,
        revision: row.revision,
        contentHash: row.content_hash,
        accessMode: row.access_mode,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        bodyBytes: row.body_bytes,
        file: `pages/${row.id}.md`,
      });
    }
    batchSize = rows.results.length;
    const last = rows.results.at(-1);
    if (last !== undefined) cursor = last.id;
  } while (batchSize === 250);
  return result;
}

async function loadPageBodies(
  database: D1Database,
  workspaceId: string,
  pages: ExportPage[],
): Promise<Map<string, PageBodyRow>> {
  if (pages.length === 0) return new Map();
  const first = requiredAt(pages, 0, "first export page");
  const last = pages.at(-1);
  if (last === undefined) throw new Error("Last export page is unavailable");
  const rows = await database
    .prepare(
      `SELECT id, revision, content_hash, body_md
         FROM pages
        WHERE workspace_id = ?1 AND id >= ?2 AND id <= ?3
        ORDER BY id`,
    )
    .bind(workspaceId, first.id, last.id)
    .all<PageBodyRow>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

function requirePageBytes(
  planned: ExportPage,
  pageBodies: ReadonlyMap<string, PageBodyRow>,
): Uint8Array {
  const actual = pageBodies.get(planned.id);
  const bytes = actual === undefined ? undefined : encoder.encode(actual.body_md);
  if (
    actual?.revision !== planned.revision ||
    actual.content_hash !== planned.contentHash ||
    bytes?.byteLength !== planned.bodyBytes
  ) {
    throw new Error("Wiki changed while the export was being created; start a new export");
  }
  return bytes;
}

async function loadPlan(bucket: R2Bucket, key: string): Promise<StoredExportPlan> {
  const object = await bucket.get(key);
  if (object === null || object.size > 32 * 1024 * 1024) {
    throw new Error("Export plan is unavailable or too large");
  }
  return storedPlanSchema.parse(await object.json<unknown>());
}

function buildManifest(
  parameters: ExportWorkflowParams,
  exportedAt: string,
  pages: ExportPage[],
): string {
  return `${JSON.stringify(
    {
      format: "nago-wiki-portable-export",
      version: 1,
      exportId: parameters.exportId,
      workspaceId: parameters.workspaceId,
      exportedAt,
      markdownDialect: "CommonMark with GFM extensions and wiki links",
      pages: pages.map((page) => ({
        id: page.id,
        parentId: page.parentId,
        slug: page.slug,
        title: page.title,
        revision: page.revision,
        contentHash: page.contentHash,
        accessMode: page.accessMode,
        status: page.status,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        file: page.file,
      })),
    },
    null,
    2,
  )}\n`;
}

function groupEntries(zip: ZipArchivePlan): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let start = 0;
  let size = 0;
  for (let index = 0; index < zip.entries.length; index += 1) {
    const entry = requiredAt(zip.entries, index, "ZIP entry");
    size += localRecordLength(entry.name, entry.size);
    if (size >= TARGET_PART_BYTES) {
      groups.push({ start, end: index + 1 });
      start = index + 1;
      size = 0;
    }
  }
  if (start < zip.entries.length) groups.push({ start, end: zip.entries.length });
  if (groups.length === 0) throw new Error("Export must contain a manifest entry");
  const last = groups.at(-1);
  if (last === undefined) throw new Error("Export archive group is unavailable");
  if (groups.length > 1 && groupSize(zip, last) < TARGET_PART_BYTES) {
    const previous = groups.at(-2);
    if (previous === undefined) throw new Error("Previous export group is unavailable");
    previous.end = last.end;
    groups.pop();
  }
  return groups;
}

function groupSize(zip: ZipArchivePlan, group: { start: number; end: number }): number {
  let size = 0;
  for (let index = group.start; index < group.end; index += 1) {
    const entry = requiredAt(zip.entries, index, "ZIP entry");
    size += localRecordLength(entry.name, entry.size);
  }
  return size;
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing ${label} at index ${String(index)}`);
  }
  return value;
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Export failed";
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 1_000);
}
