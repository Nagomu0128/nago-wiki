import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { sha256 } from "@noble/hashes/sha2.js";
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
  portableExportMemberSchema,
  portableExportPageSchema,
  portableExportPageTagSchema,
  portableExportTagSchema,
  portableExportVersionSchema,
  type PortableExportAcl,
  type PortableExportAlias,
  type PortableExportAsset,
  type PortableExportComment,
  type PortableExportLink,
  type PortableExportMember,
  type PortableExportPage,
  type PortableExportPageTag,
  type PortableExportTag,
  type PortableExportVersion,
  type PortableManifestInput,
} from "./manifest";
import type { McpRuntimeEnv } from "../mcp/types";

const encoder = new TextEncoder();
const TARGET_PART_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES_PER_STAGE = 400;
const MAX_EXPORT_MULTIPART_PARTS = 4_000;
const MAX_EXPORT_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_ARCHIVE_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_EXPORT_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_WORKFLOW_STEPS = 25_000;
const MAX_EXPORT_SNAPSHOT_CAPTURE_ATTEMPTS = 3;
// Keep one attempt below 9,200 storage calls; the configured 50,000 Workflow
// limit accommodates the default five attempts without becoming unbounded.
const MAX_EXPORT_IO_SUBREQUESTS = 5_000;
const MAX_EXPORT_METADATA_ITEMS = 50_000;
const MAX_EXPORT_METADATA_BYTES = 6 * 1024 * 1024;
const MAX_EXPORT_R2_LIST_PAGES = 50;

export const exportWorkflowParamsSchema = z
  .object({
    exportId: z.string().min(1),
    workspaceId: z.string().min(1),
    requestedBy: z.string().min(1),
    purpose: z.enum(["download", "backup"]).default("download"),
    backupDate: z.iso.date().nullable().default(null),
    retentionClass: z.enum(["weekly", "monthly"]).nullable().default(null),
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
  workspaceName: z.string(),
  exportedAt: z.string(),
  members: z.array(portableExportMemberSchema),
  pages: z.array(portableExportPageSchema),
  versions: z.array(portableExportVersionSchema),
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

interface VersionRow {
  id: string;
  page_id: string;
  revision: number;
  r2_key: string;
  content_hash: string;
  author_id: string;
  reason: "create" | "edit" | "move" | "restore" | "import" | "manual";
  storage_status: "pending" | "ready" | "failed";
  created_at: string;
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
  uploadId: string | null;
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

interface WorkspaceRow {
  name: string;
}

interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "suspended";
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

      await step.do("verify export snapshot is unchanged", async () => {
        await assertExportSnapshotUnchanged(this.env, plan.planKey);
        return { verified: true as const };
      });
      const expectedArchiveHash = await step.do(
        "hash staged portable export",
        async () =>
          hashStagedArchive(this.env.FILES, stagedParts, plan.archiveSize),
      );

      upload = await step.do("create archive multipart upload", async () =>
        createOrResumeUpload(this.env, parameters, plan, expectedArchiveHash),
      );
      const uploadId = upload.uploadId;

      const completedParts: UploadedArchivePart[] = [];
      if (uploadId !== null) {
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
      }

      const completed = await step.do("complete portable export", async () => {
        const existing = await this.env.FILES.head(plan.archiveKey);
        const object =
          existing ??
          (await completeRequiredUpload(
            this.env.FILES,
            plan.archiveKey,
            uploadId,
            completedParts,
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
      if (archiveHash !== expectedArchiveHash) {
        throw new Error("Completed export archive hash does not match staging");
      }
      await step.do("remove staged archive segments", async () => {
        await deleteR2Keys(
          this.env.FILES,
          stagedParts.map((part) => part.key),
        );
        return { removed: stagedParts.length };
      });
      await step.do("publish portable export", async () => {
        const now = new Date().toISOString();
        const expiresAt = retentionExpiresAt(parameters, new Date(now));
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
      await step
        .do("abort failed archive upload", async () => {
          const row = await this.env.DB.prepare(
            `SELECT r2_key, multipart_upload_id FROM exports WHERE id = ?1`,
          )
            .bind(parameters.exportId)
            .first<ExportDbRow>();
          try {
            if (row?.multipart_upload_id && row.r2_key) {
              const completed = await this.env.FILES.head(row.r2_key);
              if (completed === null) {
                await this.env.FILES.resumeMultipartUpload(
                  row.r2_key,
                  row.multipart_upload_id,
                )
                  .abort()
                  .catch(() => undefined);
              }
            }
          } finally {
            await this.env.DB.prepare(
              "UPDATE exports SET multipart_upload_id = NULL WHERE id = ?1",
            )
              .bind(parameters.exportId)
              .run();
          }
          return { aborted: row?.multipart_upload_id !== null };
        })
        .catch((cleanupError: unknown) => {
          console.error("Failed to clear export multipart upload", {
            exportId: parameters.exportId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : "Unknown error",
          });
        });
      await step.do("remove failed export artifacts", async () => {
        const removed = await deleteR2Prefix(
          this.env.FILES,
          exportArtifactPrefix(parameters),
        );
        return { removed };
      });
      throw error;
    }
  }
}

async function createAndStorePlan(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
): Promise<PlanStepResult> {
  const metadata = await collectStableExportMetadata(
    environment,
    parameters.workspaceId,
  );
  const {
    workspaceName,
    members,
    pages,
    versions,
    assets,
    acl,
    tags,
    pageTags,
    links,
    aliases,
    comments,
  } = metadata;
  const exportedAt = new Date().toISOString();
  const manifestInput: PortableManifestInput = {
    exportId: parameters.exportId,
    workspaceId: parameters.workspaceId,
    workspaceName,
    exportedAt,
    members,
    pages,
    versions,
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
    ...versions.map((version) => ({
      name: version.file,
      size: version.bodyBytes,
    })),
    ...assets.map((asset) => ({ name: asset.file, size: asset.size })),
    { name: "manifest.json", size: encoder.encode(manifest).byteLength },
  ]);
  if (zip.archiveSize > MAX_EXPORT_ARCHIVE_BYTES) {
    throw new Error("Export archive exceeds the 32 GiB portable export limit");
  }
  const groups = groupEntries(zip);
  const multipart = planR2MultipartUpload(zip.archiveSize);
  if (multipart.parts.length > MAX_EXPORT_MULTIPART_PARTS) {
    throw new Error(
      "Export archive exceeds the supported Workflow multipart capacity",
    );
  }
  const estimatedIoSubrequests =
    zip.entries.length + multipart.parts.length * 2 + groups.length + 100;
  if (estimatedIoSubrequests > MAX_EXPORT_IO_SUBREQUESTS) {
    throw new Error(
      "Export archive requires too many storage operations for one Workflow invocation",
    );
  }
  if (groups.length + multipart.parts.length + 12 > MAX_EXPORT_WORKFLOW_STEPS) {
    throw new Error("Export archive requires too many workflow steps");
  }
  const storedPlan: StoredExportPlan = {
    formatVersion: 1,
    exportId: parameters.exportId,
    workspaceId: parameters.workspaceId,
    workspaceName,
    exportedAt,
    members,
    pages,
    versions,
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
  const storedPlanJson = JSON.stringify(storedPlan);
  if (encoder.encode(storedPlanJson).byteLength > MAX_EXPORT_PLAN_BYTES) {
    throw new Error("Export metadata exceeds the portable plan limit");
  }
  await environment.FILES.put(planKey, storedPlanJson, {
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

async function collectExportMetadata(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  workspaceId: string,
) {
  const budget = { items: 0, bytes: 0 };
  const workspaceName = await getExportWorkspaceName(environment.DB, workspaceId);
  addMetadataBatch(budget, [workspaceName], "workspace");
  const members = await listExportMembers(environment.DB, workspaceId);
  addMetadataBatch(budget, members, "members");
  const pages = await listExportPages(environment.DB, workspaceId);
  addMetadataBatch(budget, pages, "pages");
  const versions = await listExportVersions(
    environment.DB,
    environment.FILES,
    workspaceId,
  );
  addMetadataBatch(budget, versions, "versions");
  const assets = await listExportAssets(environment.FILES, workspaceId);
  addMetadataBatch(budget, assets, "assets");
  const acl = await listExportAcl(environment.DB, workspaceId);
  addMetadataBatch(budget, acl, "ACL entries");
  const tags = await listExportTags(environment.DB, workspaceId);
  addMetadataBatch(budget, tags, "tags");
  const pageTags = await listExportPageTags(environment.DB, workspaceId);
  addMetadataBatch(budget, pageTags, "page tags");
  const links = await listExportLinks(environment.DB, workspaceId);
  addMetadataBatch(budget, links, "links");
  const aliases = await listExportAliases(environment.DB, workspaceId);
  addMetadataBatch(budget, aliases, "aliases");
  const comments = await listExportComments(environment.DB, workspaceId);
  addMetadataBatch(budget, comments, "comments");
  return {
    workspaceName,
    members,
    pages,
    versions,
    assets,
    acl,
    tags,
    pageTags,
    links,
    aliases,
    comments,
  };
}

/**
 * D1 and R2 do not share a transaction.  Capture the complete logical graph
 * twice and only plan an archive when both observations agree.  This bounds
 * the cost of contention while preventing a plan assembled across two
 * metadata generations from being published as a snapshot.
 */
async function collectStableExportMetadata(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  workspaceId: string,
) {
  let previousHash = await exportMetadataHash(
    await collectExportMetadata(environment, workspaceId),
  );
  for (
    let attempt = 1;
    attempt < MAX_EXPORT_SNAPSHOT_CAPTURE_ATTEMPTS;
    attempt += 1
  ) {
    const current = await collectExportMetadata(environment, workspaceId);
    const currentHash = await exportMetadataHash(current);
    if (currentHash === previousHash) return current;
    previousHash = currentHash;
  }
  throw new Error(
    "Wiki metadata changed while the export snapshot was being captured; retry the export",
  );
}

function exportMetadataHash(value: {
  workspaceName: string;
  members: PortableExportMember[];
  pages: PortableExportPage[];
  versions: PortableExportVersion[];
  assets: PortableExportAsset[];
  acl: PortableExportAcl[];
  tags: PortableExportTag[];
  pageTags: PortableExportPageTag[];
  links: PortableExportLink[];
  aliases: PortableExportAlias[];
  comments: PortableExportComment[];
}): Promise<string> {
  return sha256Bytes(encoder.encode(JSON.stringify(value)));
}

async function assertExportSnapshotUnchanged(
  environment: Pick<McpRuntimeEnv, "DB" | "FILES">,
  planKey: string,
): Promise<void> {
  const plan = await loadPlan(environment.FILES, planKey);
  const current = await collectStableExportMetadata(
    environment,
    plan.workspaceId,
  );
  const planned = {
    workspaceName: plan.workspaceName,
    members: plan.members,
    pages: plan.pages,
    versions: plan.versions,
    assets: plan.assets,
    acl: plan.acl,
    tags: plan.tags,
    pageTags: plan.pageTags,
    links: plan.links,
    aliases: plan.aliases,
    comments: plan.comments,
  };
  const [plannedHash, currentHash] = await Promise.all([
    exportMetadataHash(planned),
    exportMetadataHash(current),
  ]);
  if (plannedHash !== currentHash) {
    throw new Error(
      "Wiki metadata changed while the export was being created; start a new export",
    );
  }
}

async function createOrResumeUpload(
  environment: McpRuntimeEnv,
  parameters: ExportWorkflowParams,
  plan: PlanStepResult,
  expectedArchiveHash: string,
): Promise<UploadStepResult> {
  const row = await environment.DB.prepare(
    `SELECT r2_key, multipart_upload_id FROM exports WHERE id = ?1`,
  )
    .bind(parameters.exportId)
    .first<ExportDbRow>();
  const completed = await environment.FILES.head(plan.archiveKey);
  if (completed !== null) {
    const matches =
      completed.size === plan.archiveSize &&
      (await hashR2Object(
        environment.FILES,
        plan.archiveKey,
        plan.archiveSize,
      )) === expectedArchiveHash;
    if (matches) {
      if (
        row?.multipart_upload_id !== null &&
        row?.multipart_upload_id !== undefined
      ) {
        await environment.FILES.resumeMultipartUpload(
          plan.archiveKey,
          row.multipart_upload_id,
        )
          .abort()
          .catch(() => undefined);
        await environment.DB.prepare(
          "UPDATE exports SET multipart_upload_id = NULL WHERE id = ?1",
        )
          .bind(parameters.exportId)
          .run();
      }
      return { uploadId: null };
    }
    await environment.FILES.delete(plan.archiveKey);
    if (
      row?.multipart_upload_id !== null &&
      row?.multipart_upload_id !== undefined
    ) {
      await environment.FILES.resumeMultipartUpload(
        plan.archiveKey,
        row.multipart_upload_id,
      )
        .abort()
        .catch(() => undefined);
      await environment.DB.prepare(
        "UPDATE exports SET multipart_upload_id = NULL WHERE id = ?1",
      )
        .bind(parameters.exportId)
        .run();
      row.multipart_upload_id = null;
    }
  }
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
        archive_hash: expectedArchiveHash,
      },
    },
  );
  try {
    await environment.DB.prepare(
      `UPDATE exports SET multipart_upload_id = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(parameters.exportId, upload.uploadId, new Date().toISOString())
      .run();
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  return { uploadId: upload.uploadId };
}

async function hashStagedArchive(
  bucket: R2Bucket,
  stages: readonly StagedArchivePart[],
  archiveSize: number,
): Promise<string> {
  const digest = createStreamingSha256();
  for await (const chunk of streamStagedRange(bucket, stages, 0, archiveSize)) {
    await digest.update(chunk);
  }
  return digest.hex();
}

async function completeRequiredUpload(
  bucket: R2Bucket,
  archiveKey: string,
  uploadId: string | null,
  completedParts: readonly UploadedArchivePart[],
): Promise<R2Object> {
  if (uploadId === null) {
    throw new Error("Completed export archive is unavailable");
  }
  return bucket.resumeMultipartUpload(archiveKey, uploadId).complete(
    completedParts.map(({ partNumber, etag }) => ({
      partNumber,
      etag,
    })),
  );
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
      const reader = (object.body as ReadableStream<Uint8Array>).getReader();
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
  const versionEnd = plan.pages.length + plan.versions.length;
  const manifestIndex = versionEnd + plan.assets.length;
  for (let index = group.start; index < group.end; index += 1) {
    const entry = requiredAt(plan.zip.entries, index, "ZIP entry");
    yield buildStoredLocalHeader(entry);
    const checksum = new Crc32();
    let written = 0;
    if (index < plan.pages.length) {
      const page = requiredAt(plan.pages, index, "export page");
      const data = requirePageBytes(page, pageBodies);
      if ((await sha256Bytes(data)) !== page.contentHash) {
        throw new Error("Wiki page content hash does not match its body");
      }
      checksum.update(data);
      written = data.byteLength;
      yield data;
    } else if (index < versionEnd) {
      const version = requiredAt(
        plan.versions,
        index - plan.pages.length,
        "export version",
      );
      const object = await bucket.get(version.sourceKey);
      if (
        object?.size !== version.bodyBytes ||
        object.etag !== version.sourceEtag
      ) {
        throw new Error(
          "Wiki versions changed while the export was being created; start a new export",
        );
      }
      const digest = createStreamingSha256();
      const reader = (object.body as ReadableStream<Uint8Array>).getReader();
      try {
        let result = await reader.read();
        while (!result.done) {
          written += result.value.byteLength;
          checksum.update(result.value);
          await digest.update(result.value);
          yield result.value;
          result = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }
      if ((await digest.hex()) !== version.contentHash) {
        throw new Error(
          `Page version ${version.id} content hash does not match`,
        );
      }
    } else if (index < manifestIndex) {
      const asset = requiredAt(plan.assets, index - versionEnd, "export asset");
      const object = await bucket.get(asset.sourceKey);
      if (object?.size !== asset.size || object.etag !== asset.etag) {
        throw new Error(
          "Wiki assets changed while the export was being created; start a new export",
        );
      }
      const digest = createStreamingSha256();
      const reader = (object.body as ReadableStream<Uint8Array>).getReader();
      try {
        let result = await reader.read();
        while (!result.done) {
          written += result.value.byteLength;
          checksum.update(result.value);
          await digest.update(result.value);
          yield result.value;
          result = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }
      const assetSha256 = await digest.hex();
      assetHashes.set(asset.sourceKey, assetSha256);
      partAssetHashes.push({ sourceKey: asset.sourceKey, sha256: assetSha256 });
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
  const budget = { items: 0, bytes: 0 };
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
    addMetadataBatch(budget, rows.results, "page descriptors");
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

async function getExportWorkspaceName(
  database: D1Database,
  workspaceId: string,
): Promise<string> {
  const workspace = await database
    .prepare("SELECT name FROM workspaces WHERE id = ?1")
    .bind(workspaceId)
    .first<WorkspaceRow>();
  if (workspace === null) throw new Error("Export workspace does not exist");
  return workspace.name;
}

async function listExportVersions(
  database: D1Database,
  bucket: R2Bucket,
  workspaceId: string,
): Promise<PortableExportVersion[]> {
  const rows = await listWorkspaceRows<VersionRow>(
    database,
    workspaceId,
    `SELECT v.id, v.page_id, v.revision, v.r2_key, v.content_hash,
            v.author_id, v.reason, v.storage_status, v.created_at
       FROM page_versions v
       JOIN pages p ON p.id = v.page_id
      WHERE p.workspace_id = ?1
      ORDER BY v.id`,
  );
  const incomplete = rows.find((row) => row.storage_status !== "ready");
  if (incomplete !== undefined) {
    throw new Error(
      `Page version ${incomplete.id} is not durably stored; retry after outbox reconciliation`,
    );
  }
  const objects = await listR2Objects(bucket, `versions/${workspaceId}/`);
  const byKey = new Map(objects.map((object) => [object.key, object]));
  return rows.map((row) => {
    const object = byKey.get(row.r2_key);
    if (object === undefined) {
      throw new Error(`Page version ${row.id} is missing from R2`);
    }
    if (object.size > MAX_EXPORT_OBJECT_BYTES) {
      throw new Error(`Page version ${row.id} exceeds the export object limit`);
    }
    if (
      object.customMetadata?.content_hash !== undefined &&
      object.customMetadata.content_hash !== row.content_hash
    ) {
      throw new Error(`Page version ${row.id} has inconsistent R2 metadata`);
    }
    return {
      id: row.id,
      pageId: row.page_id,
      revision: row.revision,
      sourceKey: row.r2_key,
      sourceEtag: object.etag,
      contentHash: row.content_hash,
      authorId: row.author_id,
      reason: row.reason,
      createdAt: row.created_at,
      bodyBytes: object.size,
      file: `versions/${row.id}.md`,
    };
  });
}

async function listExportMembers(
  database: D1Database,
  workspaceId: string,
): Promise<PortableExportMember[]> {
  const rows = await listWorkspaceRows<MemberRow>(
    database,
    workspaceId,
    `SELECT id, email, display_name, role, status, created_at, updated_at
       FROM users
      WHERE workspace_id = ?1
      ORDER BY id`,
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function listExportAssets(
  bucket: R2Bucket,
  workspaceId: string,
): Promise<PortableExportAsset[]> {
  const prefix = `assets/${workspaceId}/`;
  const result: PortableExportAsset[] = [];
  const budget = { items: 0, bytes: 0 };
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_EXPORT_R2_LIST_PAGES) {
      throw new Error("Export assets require too many R2 listing requests");
    }
    const listing = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
      include: ["httpMetadata", "customMetadata"],
    });
    pages += 1;
    addMetadataBatch(budget, listing.objects, "R2 assets");
    for (const object of listing.objects) {
      if (object.size > MAX_EXPORT_OBJECT_BYTES) {
        throw new Error(`Asset ${object.key} exceeds the export object limit`);
      }
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
        customMetadata: sortedRecord(object.customMetadata ?? {}),
      });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  return result.sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey),
  );
}

async function listR2Objects(
  bucket: R2Bucket,
  prefix: string,
): Promise<R2Object[]> {
  const result: R2Object[] = [];
  const budget = { items: 0, bytes: 0 };
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_EXPORT_R2_LIST_PAGES) {
      throw new Error("Export versions require too many R2 listing requests");
    }
    const listing = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
      include: ["customMetadata"],
    });
    pages += 1;
    addMetadataBatch(budget, listing.objects, "R2 versions");
    result.push(...listing.objects);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  return result.sort((left, right) => left.key.localeCompare(right.key));
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
  const budget = { items: 0, bytes: 0 };
  let offset = 0;
  let batchSize: number;
  do {
    const rows = await database
      .prepare(`${query}\nLIMIT 100 OFFSET ?2`)
      .bind(workspaceId, offset)
      .all<T>();
    addMetadataBatch(budget, rows.results, "D1 export rows");
    result.push(...rows.results);
    batchSize = rows.results.length;
    offset += rows.results.length;
  } while (batchSize === 100);
  return result;
}

function addMetadataBatch(
  budget: { items: number; bytes: number },
  values: readonly unknown[],
  label: string,
): void {
  budget.items += values.length;
  if (budget.items > MAX_EXPORT_METADATA_ITEMS) {
    throw new Error(`Export ${label} exceeds the metadata item limit`);
  }
  budget.bytes += encoder.encode(JSON.stringify(values)).byteLength;
  if (budget.bytes > MAX_EXPORT_METADATA_BYTES) {
    throw new Error(`Export ${label} exceeds the metadata memory limit`);
  }
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
  if (object === null || object.size > MAX_EXPORT_PLAN_BYTES) {
    throw new Error("Export plan is unavailable or too large");
  }
  return storedPlanSchema.parse(await object.json<unknown>());
}

function sortedRecord(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function manifestInput(plan: StoredExportPlan): PortableManifestInput {
  return {
    exportId: plan.exportId,
    workspaceId: plan.workspaceId,
    workspaceName: plan.workspaceName,
    exportedAt: plan.exportedAt,
    members: plan.members,
    pages: plan.pages,
    versions: plan.versions,
    assets: plan.assets,
    acl: plan.acl,
    tags: plan.tags,
    pageTags: plan.pageTags,
    links: plan.links,
    aliases: plan.aliases,
    comments: plan.comments,
  };
}

export function groupEntries(
  zip: ZipArchivePlan,
): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let start = 0;
  let size = 0;
  for (let index = 0; index < zip.entries.length; index += 1) {
    const entry = requiredAt(zip.entries, index, "ZIP entry");
    size += localRecordLength(entry.name, entry.size);
    if (
      size >= TARGET_PART_BYTES ||
      index - start + 1 >= MAX_ENTRIES_PER_STAGE
    ) {
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
    if (last.end - previous.start <= MAX_ENTRIES_PER_STAGE) {
      previous.end = last.end;
      groups.pop();
    }
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

export function exportArtifactPrefix(
  parameters: Pick<
    ExportWorkflowParams,
    "exportId" | "workspaceId" | "purpose" | "backupDate"
  >,
): string {
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

export function retentionExpiresAt(
  parameters: ExportWorkflowParams,
  from: Date,
): string {
  const expiresAt = new Date(from);
  if (
    parameters.purpose === "backup" &&
    parameters.retentionClass === "monthly"
  ) {
    expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 12);
  } else {
    const retentionDays = parameters.purpose === "download" ? 7 : 90;
    expiresAt.setUTCDate(expiresAt.getUTCDate() + retentionDays);
  }
  return expiresAt.toISOString();
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
  const digest = createStreamingSha256();
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      await digest.update(result.value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  return digest.hex();
}

interface StreamingSha256 {
  update(value: Uint8Array): Promise<void>;
  hex(): Promise<string>;
}

function createStreamingSha256(): StreamingSha256 {
  if (typeof DigestStream !== "undefined") {
    const stream = new DigestStream("SHA-256");
    const writer = stream.getWriter();
    return {
      update: async (value) => writer.write(value),
      hex: async () => {
        await writer.close();
        return bytesToHex(new Uint8Array(await stream.digest));
      },
    };
  }
  const fallback = sha256.create();
  return {
    update(value) {
      fallback.update(value);
      return Promise.resolve();
    },
    hex() {
      return Promise.resolve(bytesToHex(fallback.digest()));
    },
  };
}

async function deleteR2Keys(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
  }
}

async function deleteR2Prefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<number> {
  let removed = 0;
  let listing: R2Objects;
  do {
    listing = await bucket.list({ prefix, limit: 1_000 });
    if (listing.objects.length > 0) {
      await bucket.delete(listing.objects.map((object) => object.key));
      removed += listing.objects.length;
    }
  } while (listing.truncated || listing.objects.length > 0);
  return removed;
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

export function safeAssetFilename(value: string): string {
  const withoutSeparators = value.normalize("NFKC").replaceAll(/[/\\:]/gu, "_");
  const normalized = Array.from(withoutSeparators, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || /[<>"|?*]/u.test(character)
      ? "_"
      : character;
  })
    .join("")
    .replace(/[. ]+$/u, "")
    .trim();
  const stem = normalized.split(".")[0]?.toUpperCase();
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL" ||
    /^(COM|LPT)[1-9]$/u.test(stem ?? "")
  ) {
    return "asset";
  }
  const bytes = new TextEncoder();
  let result = "";
  for (const character of normalized) {
    if (bytes.encode(result + character).byteLength > 200) break;
    result += character;
  }
  const portable = result.replace(/[. ]+$/u, "");
  const portableStem = portable.split(".")[0]?.toUpperCase();
  if (
    portable.length === 0 ||
    portableStem === "CON" || portableStem === "PRN" ||
    portableStem === "AUX" || portableStem === "NUL" ||
    /^(COM|LPT)[1-9]$/u.test(portableStem ?? "")
  ) {
    return "asset";
  }
  return portable;
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
