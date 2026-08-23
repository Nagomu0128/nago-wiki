import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import {
  buildCentralDirectory,
  buildStoredDataDescriptor,
  buildStoredLocalHeader,
  Crc32,
  localRecordLength,
  planR2MultipartUpload,
  planStoredZip,
  type ZipArchivePlan,
} from "./zip";
import {
  buildPortableManifest,
  portableExportAclSchema,
  portableExportAliasSchema,
  portableExportAssetSchema,
  portableExportCommentSchema,
  portableExportLinkSchema,
  portableExportPageSchema,
  portableExportPageTagSchema,
  portableExportTagSchema,
  type PortableExportAcl,
  type PortableExportAlias,
  type PortableExportAsset,
  type PortableExportComment,
  type PortableExportLink,
  type PortableExportPage,
  type PortableExportPageTag,
  type PortableExportTag,
  type PortableManifestInput,
} from "./manifest";
import type { McpRuntimeEnv } from "../mcp/types";

const encoder = new TextEncoder();
const TARGET_PART_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_WORKFLOW_STEPS = 25_000;

export const exportWorkflowParamsSchema = z
  .object({
    exportId: z.string().min(1),
    workspaceId: z.string().min(1),
    requestedBy: z.string().min(1),
    purpose: z.enum(["download", "backup"]).default("download"),
    backupDate: z.iso.date().nullable().default(null),
    retentionClass: z
      .enum(["weekly", "monthly"])
      .nullable()
      .default(null),
  })
  .superRefine((value, context) => {
    const validDownload =
      value.purpose === "download" &&
      value.backupDate === null &&
      value.retentionClass === null;
    const validBackup =
      value.purpose === "backup" &&
      value.backupDate !== null &&
      value.retentionClass !== null;
    if (!validDownload && !validBackup) {
      context.addIssue({
        code: "custom",
        message: "Backup date and retention class must match export purpose",
      });
    }
  });
export type ExportWorkflowParams = z.infer<typeof exportWorkflowParamsSchema>;

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
  pages: z.array(portableExportPageSchema),
  assets: z.array(portableExportAssetSchema),
  acl: z.array(portableExportAclSchema),
  tags: z.array(portableExportTagSchema),
  pageTags: z.array(portableExportPageTagSchema),
  links: z.array(portableExportLinkSchema),
  aliases: z.array(portableExportAliasSchema),
  comments: z.array(portableExportCommentSchema),
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
  trashed_at: string | null;
  trash_batch_id: string | null;
  created_at: string;
  updated_at: string;
  body_bytes: number;
  created_by: string;
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

export interface PlanStepResult {
  planKey: string;
  archiveKey: string;
  archiveSize: number;
  pageCount: number;
  stageCount: number;
  partCount: number;
  partSize: number;
}

interface UploadStepResult {
  uploadId: string;
}

export interface StagedArchivePart {
  key: string;
  size: number;
  crc32: number[];
  assetHashes: { sourceKey: string; sha256: string }[];
}

interface UploadedArchivePart {
  partNumber: number;
  etag: string;
}

interface AclRow {
  page_id: string;
  user_id: string;
  user_email: string;
  permission: "editor" | "viewer";
  created_at: string;
  updated_at: string;
}

interface TagRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: string;
}

interface PageTagRow {
  page_id: string;
  tag_id: string;
}

interface LinkRow {
  source_page_id: string;
  target_page_id: string | null;
  raw_target: string;
  source_revision: number;
  created_at: string;
}

interface AliasRow {
  normalized_path: string;
  page_id: string;
  created_at: string;
}

interface CommentRow {
  id: string;
  page_id: string;
  author_id: string;
  author_email: string;
  body_md: string;
  status: "open" | "resolved" | "deleted";
  created_at: string;
  updated_at: string;
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
    const stagedParts: StagedArchivePart[] = [];
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

      for (let index = 0; index < plan.stageCount; index += 1) {
        const previousCrcs =
          index === plan.stageCount - 1
            ? stagedParts.flatMap((part) => part.crc32)
            : [];
        const previousAssetHashes =
          index === plan.stageCount - 1
            ? stagedParts.flatMap((part) => part.assetHashes)
            : [];
        const part = await step.do(
          `stage archive segment ${String(index + 1).padStart(5, "0")}`,
          async () =>
            stageArchiveSegment(
              this.env,
              plan,
              index,
              previousCrcs,
              previousAssetHashes,
            ),
        );
        stagedParts.push(part);
      }

      upload = await step.do("create archive multipart upload", async () =>
        createOrResumeUpload(this.env, parameters, plan),
      );
      const uploadId = upload.uploadId;

      const completedParts: UploadedArchivePart[] = [];
      for (let index = 0; index < plan.partCount; index += 1) {
        const part = await step.do(
          `upload archive part ${String(index + 1).padStart(5, "0")}`,
          async () =>
            uploadArchivePart(
              this.env.FILES,
              plan,
              stagedParts,
              uploadId,
              index,
            ),
        );
        completedParts.push(part);
      }

      const completed = await step.do("complete portable export", async () => {
        const existing = await this.env.FILES.head(plan.archiveKey);
        const object =
          existing ??
          (await this.env.FILES.resumeMultipartUpload(
            plan.archiveKey,
            uploadId,
          ).complete(
            completedParts.map(({ partNumber, etag }) => ({
              partNumber,
              etag,
            })),
          ));
        if (object.size !== plan.archiveSize) {
          throw new Error(
            "Completed export archive size does not match its plan",
          );
        }
        return { size: object.size };
      });
      const archiveHash = await step.do("verify portable export", async () =>
        hashR2Object(this.env.FILES, plan.archiveKey, plan.archiveSize),
      );
      await step.do("remove staged archive segments", async () => {
        await deleteR2Keys(
          this.env.FILES,
          stagedParts.map((part) => part.key),
        );
        return { removed: stagedParts.length };
      });
      await step.do("publish portable export", async () => {
        const expiresAt = new Date(
          Date.now() +
            retentionDaysForExport(parameters) * 24 * 60 * 60 * 1_000,
        ).toISOString();
        const now = new Date().toISOString();
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE exports
                SET status = 'ready', r2_key = ?2, archive_size = ?3,
                    archive_hash = ?4, multipart_upload_id = NULL,
                    updated_at = ?5, expires_at = ?6
              WHERE id = ?1`,
          ).bind(
            parameters.exportId,
            plan.archiveKey,
            completed.size,
            archiveHash,
            now,
            expiresAt,
          ),
          this.env.DB.prepare(
            `INSERT INTO audit_events (
               id, actor_id, action, target_type, target_id, metadata_json, created_at
             ) VALUES (?1, ?2, ?3, 'export', ?4, ?5, ?6)
             ON CONFLICT(id) DO NOTHING`,
          ).bind(
            parameters.exportId,
            parameters.requestedBy,
            parameters.purpose === "backup"
              ? "backup.completed"
              : "export.completed",
            parameters.exportId,
            JSON.stringify({
              archiveSize: completed.size,
              archiveHash,
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
      await step.do("mark export failed", async () => {
        const failedAt = new Date();
        await this.env.DB.prepare(
          `UPDATE exports
              SET status = 'failed', error_message = ?2,
                  updated_at = ?3, expires_at = ?4
            WHERE id = ?1`,
        )
          .bind(
            parameters.exportId,
            publicErrorMessage(error),
            failedAt.toISOString(),
            new Date(
              failedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
            ).toISOString(),
          )
          .run();
        return { status: "failed" as const };
      });
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
          await this.env.DB.prepare(
            "UPDATE exports SET multipart_upload_id = NULL WHERE id = ?1",
          )
            .bind(parameters.exportId)
            .run();
          return { aborted: true as const };
        });
      }
      if (stagedParts.length > 0) {
        await step.do("remove failed archive segments", async () => {
          await deleteR2Keys(
            this.env.FILES,
            stagedParts.map((part) => part.key),
          );
          return { removed: stagedParts.length };
        });
      }
      throw error;
    }
  }
}

async function createAndStorePlan(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
): Promise<PlanStepResult> {
  const [pages, assets, acl, tags, pageTags, links, aliases, comments] =
    await Promise.all([
      listExportPages(environment.DB, parameters.workspaceId),
      listExportAssets(environment.FILES, parameters.workspaceId),
      listExportAcl(environment.DB, parameters.workspaceId),
      listExportTags(environment.DB, parameters.workspaceId),
      listExportPageTags(environment.DB, parameters.workspaceId),
      listExportLinks(environment.DB, parameters.workspaceId),
      listExportAliases(environment.DB, parameters.workspaceId),
      listExportComments(environment.DB, parameters.workspaceId),
    ]);
  const exportedAt = new Date().toISOString();
  const manifestInput: PortableManifestInput = {
    exportId: parameters.exportId,
    workspaceId: parameters.workspaceId,
    exportedAt,
    pages,
    assets,
    acl,
    tags,
    pageTags,
    links,
    aliases,
    comments,
  };
  const manifest = buildPortableManifest(manifestInput, new Map(), true);
  const zip = planStoredZip([
    ...pages.map((page) => ({ name: page.file, size: page.bodyBytes })),
    ...assets.map((asset) => ({ name: asset.file, size: asset.size })),
    { name: "manifest.json", size: encoder.encode(manifest).byteLength },
  ]);
  const groups = groupEntries(zip);
  const multipart = planR2MultipartUpload(zip.archiveSize);
  if (groups.length + multipart.parts.length + 12 > MAX_EXPORT_WORKFLOW_STEPS) {
    throw new Error("Export archive requires too many workflow steps");
  }
  const storedPlan: StoredExportPlan = {
    formatVersion: 1,
    exportId: parameters.exportId,
    workspaceId: parameters.workspaceId,
    exportedAt,
    pages,
    assets,
    acl,
    tags,
    pageTags,
    links,
    aliases,
    comments,
    zip,
    groups,
  };
  const prefix = exportArtifactPrefix(parameters);
  const planKey = `${prefix}plan.json`;
  const archiveKey = `${prefix}wiki-export.zip`;
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
    stageCount: groups.length,
    partCount: multipart.parts.length,
    partSize: multipart.partSize,
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
  const upload = await environment.FILES.createMultipartUpload(
    plan.archiveKey,
    {
      httpMetadata: {
        contentType: "application/zip",
        contentDisposition: `attachment; filename="nago-wiki-${parameters.exportId}.zip"`,
      },
      customMetadata: {
        export_id: parameters.exportId,
        workspace_id: parameters.workspaceId,
      },
    },
  );
  await environment.DB.prepare(
    `UPDATE exports SET multipart_upload_id = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(parameters.exportId, upload.uploadId, new Date().toISOString())
    .run();
  return { uploadId: upload.uploadId };
}

export async function stageArchiveSegment(
  environment: McpRuntimeEnv,
  summary: PlanStepResult,
  stageIndex: number,
  previousCrcs: number[],
  previousAssetHashes: { sourceKey: string; sha256: string }[],
): Promise<StagedArchivePart> {
  const plan = await loadPlan(environment.FILES, summary.planKey);
  const group = plan.groups[stageIndex];
  if (group === undefined)
    throw new Error("Export archive part is outside its plan");
  const pageIndexes = range(
    group.start,
    Math.min(group.end, plan.pages.length),
  );
  const pageBodies = await loadPageBodies(
    environment.DB,
    plan.workspaceId,
    pageIndexes.map((index) => requiredAt(plan.pages, index, "export page")),
  );
  const partCrcs: number[] = [];
  const partAssetHashes: { sourceKey: string; sha256: string }[] = [];
  const assetHashes = new Map(
    previousAssetHashes.map(({ sourceKey, sha256 }) => [sourceKey, sha256]),
  );
  const expectedSize =
    groupSize(plan.zip, group) +
    (stageIndex === plan.groups.length - 1
      ? plan.zip.archiveSize - plan.zip.centralOffset
      : 0);
  const body = readableFromAsyncIterable(
    streamArchivePart(
      environment.FILES,
      plan,
      group,
      pageBodies,
      previousCrcs,
      partCrcs,
      partAssetHashes,
      assetHashes,
      stageIndex === plan.groups.length - 1,
    ),
  );
  const key = `${artifactPrefixFromArchiveKey(summary.archiveKey)}staging/${String(stageIndex + 1).padStart(5, "0")}.bin`;
  const fixed = new FixedLengthStream(expectedSize);
  await Promise.all([
    environment.FILES.put(key, fixed.readable, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        export_id: plan.exportId,
        stage: String(stageIndex + 1),
      },
    }),
    body.pipeTo(fixed.writable),
  ]);
  const staged = await environment.FILES.head(key);
  if (staged?.size !== expectedSize) {
    throw new Error("Staged export segment size does not match its plan");
  }
  return {
    key,
    size: expectedSize,
    crc32: partCrcs,
    assetHashes: partAssetHashes,
  };
}

export async function uploadArchivePart(
  bucket: R2Bucket,
  plan: PlanStepResult,
  stages: readonly StagedArchivePart[],
  uploadId: string,
  partIndex: number,
): Promise<UploadedArchivePart> {
  const offset = partIndex * plan.partSize;
  const size = Math.min(plan.partSize, plan.archiveSize - offset);
  if (size <= 0) throw new Error("Archive part is outside its plan");
  if (partIndex < plan.partCount - 1 && size !== plan.partSize) {
    throw new Error("Non-final archive part is not uniformly sized");
  }
  const body = readableFromAsyncIterable(
    streamStagedRange(bucket, stages, offset, size),
  );
  const fixed = new FixedLengthStream(size);
  const [uploaded] = await Promise.all([
    bucket
      .resumeMultipartUpload(plan.archiveKey, uploadId)
      .uploadPart(partIndex + 1, fixed.readable),
    body.pipeTo(fixed.writable),
  ]);
  return { partNumber: uploaded.partNumber, etag: uploaded.etag };
}

export async function* streamStagedRange(
  bucket: R2Bucket,
  stages: readonly StagedArchivePart[],
  archiveOffset: number,
  length: number,
): AsyncGenerator<Uint8Array> {
  let stageStart = 0;
  let remaining = length;
  let written = 0;
  for (const stage of stages) {
    const stageEnd = stageStart + stage.size;
    if (remaining > 0 && archiveOffset < stageEnd) {
      const relativeOffset = Math.max(0, archiveOffset - stageStart);
      const take = Math.min(remaining, stage.size - relativeOffset);
      const object = await bucket.get(stage.key, {
        range: { offset: relativeOffset, length: take },
      });
      if (object === null) throw new Error("Staged export segment is missing");
      const reader = (
        object.body as ReadableStream<Uint8Array>
      ).getReader();
      let received = 0;
      try {
        let result = await reader.read();
        while (!result.done) {
          received += result.value.byteLength;
          written += result.value.byteLength;
          yield result.value;
          result = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }
      if (received !== take) {
        throw new Error("Staged export range size does not match its plan");
      }
      remaining -= take;
    }
    stageStart = stageEnd;
    if (remaining === 0) break;
  }
  if (written !== length || remaining !== 0) {
    throw new Error("Staged export archive is incomplete");
  }
}

async function* streamArchivePart(
  bucket: R2Bucket,
  plan: StoredExportPlan,
  group: { start: number; end: number },
  pageBodies: ReadonlyMap<string, PageBodyRow>,
  previousCrcs: number[],
  partCrcs: number[],
  partAssetHashes: { sourceKey: string; sha256: string }[],
  assetHashes: Map<string, string>,
  includeCentralDirectory: boolean,
): AsyncGenerator<Uint8Array> {
  const manifestIndex = plan.pages.length + plan.assets.length;
  for (let index = group.start; index < group.end; index += 1) {
    const entry = requiredAt(plan.zip.entries, index, "ZIP entry");
    yield buildStoredLocalHeader(entry);
    const checksum = new Crc32();
    let written = 0;
    if (index < plan.pages.length) {
      const page = requiredAt(plan.pages, index, "export page");
      const data = requirePageBytes(
        page,
        pageBodies,
      );
      if ((await sha256Bytes(data)) !== page.contentHash) {
        throw new Error("Wiki page content hash does not match its body");
      }
      checksum.update(data);
      written = data.byteLength;
      yield data;
    } else if (index < manifestIndex) {
      const asset = requiredAt(
        plan.assets,
        index - plan.pages.length,
        "export asset",
      );
      const object = await bucket.get(asset.sourceKey);
      if (object?.size !== asset.size || object.etag !== asset.etag) {
        throw new Error(
          "Wiki assets changed while the export was being created; start a new export",
        );
      }
      const digest = new DigestStream("SHA-256");
      const digestWriter = digest.getWriter();
      const reader = (object.body as ReadableStream<Uint8Array>).getReader();
      try {
        let result = await reader.read();
        while (!result.done) {
          written += result.value.byteLength;
          checksum.update(result.value);
          await digestWriter.write(result.value);
          yield result.value;
          result = await reader.read();
        }
        await digestWriter.close();
      } catch (error) {
        await digestWriter.abort(error);
        throw error;
      } finally {
        reader.releaseLock();
      }
      const sha256 = bytesToHex(new Uint8Array(await digest.digest));
      assetHashes.set(asset.sourceKey, sha256);
      partAssetHashes.push({ sourceKey: asset.sourceKey, sha256 });
    } else if (index === manifestIndex) {
      const data = encoder.encode(
        buildPortableManifest(manifestInput(plan), assetHashes),
      );
      checksum.update(data);
      written = data.byteLength;
      yield data;
    } else {
      throw new Error("Export archive entry is outside its plan");
    }
    if (written !== entry.size) {
      throw new Error(`ZIP entry size changed for ${entry.name}`);
    }
    const value = checksum.digest();
    partCrcs.push(value);
    yield buildStoredDataDescriptor(entry, value);
  }
  if (includeCentralDirectory) {
    const allCrcs = [...previousCrcs, ...partCrcs];
    if (allCrcs.length !== plan.zip.entries.length) {
      throw new Error("Export archive CRC list is incomplete");
    }
    yield buildCentralDirectory(
      plan.zip,
      new Map(
        plan.zip.entries.map((entry, index) => [
          entry.name,
          requiredAt(allCrcs, index, "ZIP CRC"),
        ]),
      ),
    );
  }
}

async function listExportPages(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportPage[]> {
  const result: PortableExportPage[] = [];
  let cursor = "";
  let batchSize: number;
  do {
    const rows = await database
      .prepare(
        `SELECT id, parent_id, slug, title, revision, content_hash, created_by,
                access_mode, status, trashed_at, trash_batch_id,
                created_at, updated_at,
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
        trashedAt: row.trashed_at,
        trashBatchId: row.trash_batch_id,
        createdBy: row.created_by,
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

async function listExportAssets(
  bucket: R2Bucket,
  workspaceId: string,
): Promise<PortableExportAsset[]> {
  const prefix = `assets/${workspaceId}/`;
  const result: PortableExportAsset[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
      include: ["httpMetadata", "customMetadata"],
    });
    for (const object of listing.objects) {
      const relative = object.key.slice(prefix.length);
      const segments = relative.split("/");
      const filename = safeAssetFilename(segments.at(-1) ?? "asset");
      result.push({
        sourceKey: object.key,
        pageId: nonEmpty(segments[0]),
        assetId: nonEmpty(segments[1]),
        filename,
        file: `assets/${String(result.length + 1).padStart(8, "0")}/${filename}`,
        size: object.size,
        etag: object.etag,
        uploadedAt: object.uploaded.toISOString(),
        ...(object.httpMetadata?.contentType === undefined
          ? {}
          : { contentType: object.httpMetadata.contentType }),
        ...(object.httpMetadata?.contentDisposition === undefined
          ? {}
          : { contentDisposition: object.httpMetadata.contentDisposition }),
        customMetadata: object.customMetadata ?? {},
      });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  return result;
}

async function listExportAcl(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportAcl[]> {
  const rows = await listWorkspaceRows<AclRow>(
    database,
    workspaceId,
    `SELECT pa.page_id, pa.user_id, u.email AS user_email, pa.permission,
            pa.created_at, pa.updated_at
       FROM page_acl pa
       JOIN pages p ON p.id = pa.page_id
       JOIN users u ON u.id = pa.user_id
      WHERE p.workspace_id = ?1
      ORDER BY pa.page_id, pa.user_id`,
  );
  return rows.map((row) => ({
    pageId: row.page_id,
    userId: row.user_id,
    userEmail: row.user_email,
    permission: row.permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function listExportTags(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportTag[]> {
  const rows = await listWorkspaceRows<TagRow>(
    database,
    workspaceId,
    `SELECT id, name, normalized_name, created_at
       FROM tags
      WHERE workspace_id = ?1
      ORDER BY id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
  }));
}

async function listExportPageTags(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportPageTag[]> {
  const rows = await listWorkspaceRows<PageTagRow>(
    database,
    workspaceId,
    `SELECT pt.page_id, pt.tag_id
       FROM page_tags pt
       JOIN pages p ON p.id = pt.page_id
      WHERE p.workspace_id = ?1
      ORDER BY pt.page_id, pt.tag_id`,
  );
  return rows.map((row) => ({ pageId: row.page_id, tagId: row.tag_id }));
}

async function listExportLinks(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportLink[]> {
  const rows = await listWorkspaceRows<LinkRow>(
    database,
    workspaceId,
    `SELECT pl.source_page_id, pl.target_page_id, pl.raw_target,
            pl.source_revision, pl.created_at
       FROM page_links pl
       JOIN pages p ON p.id = pl.source_page_id
      WHERE p.workspace_id = ?1
      ORDER BY pl.source_page_id, pl.raw_target`,
  );
  return rows.map((row) => ({
    sourcePageId: row.source_page_id,
    targetPageId: row.target_page_id,
    rawTarget: row.raw_target,
    sourceRevision: row.source_revision,
    createdAt: row.created_at,
  }));
}

async function listExportAliases(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportAlias[]> {
  const rows = await listWorkspaceRows<AliasRow>(
    database,
    workspaceId,
    `SELECT normalized_path, page_id, created_at
       FROM page_aliases
      WHERE workspace_id = ?1
      ORDER BY normalized_path`,
  );
  return rows.map((row) => ({
    normalizedPath: row.normalized_path,
    pageId: row.page_id,
    createdAt: row.created_at,
  }));
}

async function listExportComments(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportComment[]> {
  const rows = await listWorkspaceRows<CommentRow>(
    database,
    workspaceId,
    `SELECT c.id, c.page_id, c.author_id, u.email AS author_email, c.body_md,
            c.status, c.created_at, c.updated_at
       FROM comments c
       JOIN pages p ON p.id = c.page_id
       JOIN users u ON u.id = c.author_id
      WHERE p.workspace_id = ?1
      ORDER BY c.page_id, c.created_at, c.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    authorId: row.author_id,
    authorEmail: row.author_email,
    bodyMd: row.body_md,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function listWorkspaceRows<T>(
  database: D1Database,
  workspaceId: string,
  query: string,
): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  let batchSize: number;
  do {
    const rows = await database
      .prepare(`${query}\nLIMIT 500 OFFSET ?2`)
      .bind(workspaceId, offset)
      .all<T>();
    result.push(...rows.results);
    batchSize = rows.results.length;
    offset += rows.results.length;
  } while (batchSize === 500);
  return result;
}

async function loadPageBodies(
  database: D1Database,
  workspaceId: string,
  pages: PortableExportPage[],
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
  planned: PortableExportPage,
  pageBodies: ReadonlyMap<string, PageBodyRow>,
): Uint8Array {
  const actual = pageBodies.get(planned.id);
  const bytes =
    actual === undefined ? undefined : encoder.encode(actual.body_md);
  if (
    actual?.revision !== planned.revision ||
    actual.content_hash !== planned.contentHash ||
    bytes?.byteLength !== planned.bodyBytes
  ) {
    throw new Error(
      "Wiki changed while the export was being created; start a new export",
    );
  }
  return bytes;
}

async function loadPlan(
  bucket: R2Bucket,
  key: string,
): Promise<StoredExportPlan> {
  const object = await bucket.get(key);
  if (object === null || object.size > 32 * 1024 * 1024) {
    throw new Error("Export plan is unavailable or too large");
  }
  return storedPlanSchema.parse(await object.json<unknown>());
}

function manifestInput(plan: StoredExportPlan): PortableManifestInput {
  return {
    exportId: plan.exportId,
    workspaceId: plan.workspaceId,
    exportedAt: plan.exportedAt,
    pages: plan.pages,
    assets: plan.assets,
    acl: plan.acl,
    tags: plan.tags,
    pageTags: plan.pageTags,
    links: plan.links,
    aliases: plan.aliases,
    comments: plan.comments,
  };
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
  if (start < zip.entries.length)
    groups.push({ start, end: zip.entries.length });
  if (groups.length === 0)
    throw new Error("Export must contain a manifest entry");
  const last = groups.at(-1);
  if (last === undefined)
    throw new Error("Export archive group is unavailable");
  if (groups.length > 1 && groupSize(zip, last) < TARGET_PART_BYTES) {
    const previous = groups.at(-2);
    if (previous === undefined)
      throw new Error("Previous export group is unavailable");
    previous.end = last.end;
    groups.pop();
  }
  return groups;
}

function groupSize(
  zip: ZipArchivePlan,
  group: { start: number; end: number },
): number {
  let size = 0;
  for (let index = group.start; index < group.end; index += 1) {
    const entry = requiredAt(zip.entries, index, "ZIP entry");
    size += localRecordLength(entry.name, entry.size);
  }
  return size;
}

function exportArtifactPrefix(parameters: ExportWorkflowParams): string {
  const workspace = encodeURIComponent(parameters.workspaceId);
  if (parameters.purpose === "backup") {
    if (parameters.backupDate === null) {
      throw new Error("Backup export date is unavailable");
    }
    return `backups/${workspace}/${parameters.backupDate}/`;
  }
  return `exports/${workspace}/${encodeURIComponent(parameters.exportId)}/`;
}

function artifactPrefixFromArchiveKey(archiveKey: string): string {
  const slash = archiveKey.lastIndexOf("/");
  if (slash <= 0) throw new Error("Export archive key is invalid");
  return archiveKey.slice(0, slash + 1);
}

export function retentionDaysForExport(
  parameters: ExportWorkflowParams,
): number {
  if (parameters.purpose === "download") return 7;
  return parameters.retentionClass === "monthly" ? 365 : 90;
}

async function hashR2Object(
  bucket: R2Bucket,
  key: string,
  expectedSize: number,
): Promise<string> {
  const object = await bucket.get(key);
  if (object?.size !== expectedSize) {
    throw new Error("Completed export archive is unavailable or incomplete");
  }
  const digest = new DigestStream("SHA-256");
  await object.body.pipeTo(digest);
  return bytesToHex(new Uint8Array(await digest.digest));
}

async function deleteR2Keys(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
  }
}

function range(start: number, end: number): number[] {
  return Array.from(
    { length: Math.max(0, end - start) },
    (_, index) => start + index,
  );
}

function readableFromAsyncIterable(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return bytesToHex(new Uint8Array(digest));
}

function safeAssetFilename(value: string): string {
  const withoutSeparators = value.normalize("NFKC").replaceAll(/[/\\]/gu, "_");
  const normalized = Array.from(withoutSeparators, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "_" : character;
  })
    .join("")
    .trim();
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    return "asset";
  }
  return normalized.slice(0, 200);
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
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
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 1_000);
}
