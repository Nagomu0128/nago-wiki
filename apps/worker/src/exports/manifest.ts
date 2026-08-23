import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const portablePathSchema = z.string().min(1).max(4_096).refine(isPortablePath, {
  message: "Archive paths must be normalized relative POSIX paths",
});

export const portableExportPageSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    slug: z.string(),
    title: z.string(),
    revision: z.number().int().positive(),
    contentHash: sha256Schema,
    accessMode: z.enum(["workspace", "restricted"]),
    status: z.enum(["active", "trashed"]),
    trashedAt: z.string().nullable(),
    trashBatchId: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    bodyBytes: z.number().int().nonnegative(),
    file: portablePathSchema,
  })
  .strict();
export type PortableExportPage = z.infer<typeof portableExportPageSchema>;

export const portableExportMemberSchema = z
  .object({
    id: z.string(),
    email: z.string().min(3).max(320),
    displayName: z.string(),
    role: z.enum(["owner", "editor", "viewer"]),
    status: z.enum(["active", "suspended"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PortableExportMember = z.infer<typeof portableExportMemberSchema>;

export const portableExportAssetSchema = z
  .object({
    sourceKey: z.string(),
    pageId: z.string().nullable(),
    assetId: z.string().nullable(),
    filename: z.string(),
    file: portablePathSchema,
    size: z.number().int().nonnegative(),
    etag: z.string(),
    uploadedAt: z.string(),
    contentType: z.string().optional(),
    contentDisposition: z.string().optional(),
    customMetadata: z.record(z.string(), z.string()),
  })
  .strict();
export type PortableExportAsset = z.infer<typeof portableExportAssetSchema>;

export const portableExportAclSchema = z
  .object({
    pageId: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    permission: z.enum(["editor", "viewer"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PortableExportAcl = z.infer<typeof portableExportAclSchema>;

export const portableExportTagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    normalizedName: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type PortableExportTag = z.infer<typeof portableExportTagSchema>;

export const portableExportPageTagSchema = z
  .object({
    pageId: z.string(),
    tagId: z.string(),
  })
  .strict();
export type PortableExportPageTag = z.infer<typeof portableExportPageTagSchema>;

export const portableExportLinkSchema = z
  .object({
    sourcePageId: z.string(),
    targetPageId: z.string().nullable(),
    rawTarget: z.string(),
    sourceRevision: z.number().int().positive(),
    createdAt: z.string(),
  })
  .strict();
export type PortableExportLink = z.infer<typeof portableExportLinkSchema>;

export const portableExportAliasSchema = z
  .object({
    normalizedPath: z.string(),
    pageId: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type PortableExportAlias = z.infer<typeof portableExportAliasSchema>;

export const portableExportCommentSchema = z
  .object({
    id: z.string(),
    pageId: z.string(),
    authorId: z.string(),
    authorEmail: z.string(),
    bodyMd: z.string(),
    status: z.enum(["open", "resolved", "deleted"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PortableExportComment = z.infer<typeof portableExportCommentSchema>;

export interface PortableManifestInput {
  exportId: string;
  workspaceId: string;
  workspaceName: string;
  exportedAt: string;
  members: PortableExportMember[];
  pages: PortableExportPage[];
  assets: PortableExportAsset[];
  acl: PortableExportAcl[];
  tags: PortableExportTag[];
  pageTags: PortableExportPageTag[];
  links: PortableExportLink[];
  aliases: PortableExportAlias[];
  comments: PortableExportComment[];
}

const PLACEHOLDER_SHA256 = "0".repeat(64);

const portableManifestPageSchema = portableExportPageSchema
  .omit({ bodyBytes: true })
  .extend({ sha256: sha256Schema, size: z.number().int().nonnegative() })
  .strict();
const portableManifestAssetSchema = portableExportAssetSchema
  .omit({ etag: true })
  .extend({ sha256: sha256Schema, sourceEtag: z.string() })
  .strict();

export const portableManifestSchema = z
  .object({
    format: z.literal("nago-wiki-portable-export"),
    version: z.literal(1),
    exportId: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    exportedAt: z.string().min(1),
    markdownDialect: z.literal("CommonMark with GFM extensions and wiki links"),
    integrityAlgorithm: z.literal("sha256"),
    counts: z
      .object({
        members: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        assets: z.number().int().nonnegative(),
        acl: z.number().int().nonnegative(),
        tags: z.number().int().nonnegative(),
        pageTags: z.number().int().nonnegative(),
        links: z.number().int().nonnegative(),
        aliases: z.number().int().nonnegative(),
        comments: z.number().int().nonnegative(),
      })
      .strict(),
    members: z.array(portableExportMemberSchema),
    pages: z.array(portableManifestPageSchema),
    assets: z.array(portableManifestAssetSchema),
    acl: z.array(portableExportAclSchema),
    tags: z.array(portableExportTagSchema),
    pageTags: z.array(portableExportPageTagSchema),
    links: z.array(portableExportLinkSchema),
    aliases: z.array(portableExportAliasSchema),
    comments: z.array(portableExportCommentSchema),
  })
  .strict()
  .superRefine(validateManifestGraph);
export type PortableManifest = z.infer<typeof portableManifestSchema>;

export function buildPortableManifest(
  input: PortableManifestInput,
  assetHashes: ReadonlyMap<string, string>,
  allowPlaceholders = false,
): string {
  return `${JSON.stringify(
    {
      format: "nago-wiki-portable-export",
      version: 1,
      exportId: input.exportId,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      exportedAt: input.exportedAt,
      markdownDialect: "CommonMark with GFM extensions and wiki links",
      integrityAlgorithm: "sha256",
      counts: {
        members: input.members.length,
        pages: input.pages.length,
        assets: input.assets.length,
        acl: input.acl.length,
        tags: input.tags.length,
        pageTags: input.pageTags.length,
        links: input.links.length,
        aliases: input.aliases.length,
        comments: input.comments.length,
      },
      members: input.members,
      pages: input.pages.map((page) => ({
        id: page.id,
        parentId: page.parentId,
        slug: page.slug,
        title: page.title,
        revision: page.revision,
        contentHash: page.contentHash,
        sha256: page.contentHash,
        accessMode: page.accessMode,
        status: page.status,
        trashedAt: page.trashedAt,
        trashBatchId: page.trashBatchId,
        createdBy: page.createdBy,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        file: page.file,
        size: page.bodyBytes,
      })),
      assets: input.assets.map((asset) => ({
        sourceKey: asset.sourceKey,
        pageId: asset.pageId,
        assetId: asset.assetId,
        filename: asset.filename,
        file: asset.file,
        size: asset.size,
        sha256: requireAssetHash(
          asset.sourceKey,
          assetHashes,
          allowPlaceholders,
        ),
        sourceEtag: asset.etag,
        uploadedAt: asset.uploadedAt,
        ...(asset.contentType === undefined
          ? {}
          : { contentType: asset.contentType }),
        ...(asset.contentDisposition === undefined
          ? {}
          : { contentDisposition: asset.contentDisposition }),
        customMetadata: asset.customMetadata,
      })),
      acl: input.acl,
      tags: input.tags,
      pageTags: input.pageTags,
      links: input.links,
      aliases: input.aliases,
      comments: input.comments,
    },
    null,
    2,
  )}\n`;
}

export function parsePortableManifest(value: unknown): PortableManifest {
  return portableManifestSchema.parse(value);
}

function requireAssetHash(
  sourceKey: string,
  hashes: ReadonlyMap<string, string>,
  allowPlaceholder: boolean,
): string {
  const value = hashes.get(sourceKey);
  if (value !== undefined && /^[a-f\d]{64}$/u.test(value)) return value;
  if (allowPlaceholder && value === undefined) return PLACEHOLDER_SHA256;
  throw new Error(`Missing SHA-256 for export asset ${sourceKey}`);
}

function validateManifestGraph(
  manifest: Omit<PortableManifest, never>,
  context: z.RefinementCtx,
): void {
  checkCount(manifest, "members", context);
  checkCount(manifest, "pages", context);
  checkCount(manifest, "assets", context);
  checkCount(manifest, "acl", context);
  checkCount(manifest, "tags", context);
  checkCount(manifest, "pageTags", context);
  checkCount(manifest, "links", context);
  checkCount(manifest, "aliases", context);
  checkCount(manifest, "comments", context);

  const pageIds = uniqueValues(
    manifest.pages.map((page) => page.id),
    ["pages"],
    context,
  );
  const memberIds = uniqueValues(
    manifest.members.map((member) => member.id),
    ["members"],
    context,
  );
  uniqueValues(
    manifest.members.map((member) => member.email.toLowerCase()),
    ["members"],
    context,
  );
  const tagIds = uniqueValues(
    manifest.tags.map((tag) => tag.id),
    ["tags"],
    context,
  );
  uniqueValues(
    manifest.tags.map((tag) => tag.normalizedName),
    ["tags"],
    context,
  );
  uniqueValues(
    manifest.aliases.map((alias) => alias.normalizedPath),
    ["aliases"],
    context,
  );
  uniqueValues(
    manifest.comments.map((comment) => comment.id),
    ["comments"],
    context,
  );
  uniqueValues(
    manifest.acl.map((entry) => `${entry.pageId}\0${entry.userId}`),
    ["acl"],
    context,
  );
  uniqueValues(
    manifest.pageTags.map((entry) => `${entry.pageId}\0${entry.tagId}`),
    ["pageTags"],
    context,
  );
  uniqueValues(
    manifest.pages.map((page) => page.file),
    ["pages"],
    context,
  );
  uniqueValues(
    manifest.assets.map((asset) => asset.file),
    ["assets"],
    context,
  );
  uniqueValues(
    manifest.assets.map((asset) => asset.sourceKey),
    ["assets"],
    context,
  );
  const archivePaths = new Set<string>(["manifest.json"]);
  for (const [index, file] of [
    ...manifest.pages.map((page) => page.file),
    ...manifest.assets.map((asset) => asset.file),
  ].entries()) {
    if (archivePaths.has(file)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate or reserved archive path: ${file}`,
        path: [index < manifest.pages.length ? "pages" : "assets"],
      });
    }
    archivePaths.add(file);
  }
  for (const [index, page] of manifest.pages.entries()) {
    if (page.contentHash !== page.sha256) {
      context.addIssue({
        code: "custom",
        message: "Page contentHash and sha256 must match",
        path: ["pages", index, "sha256"],
      });
    }
    if (page.parentId !== null && !pageIds.has(page.parentId)) {
      context.addIssue({
        code: "custom",
        message: "Page parentId does not exist in the manifest",
        path: ["pages", index, "parentId"],
      });
    }
    if (!memberIds.has(page.createdBy)) {
      context.addIssue({
        code: "custom",
        message: "Page createdBy does not exist in the manifest",
        path: ["pages", index, "createdBy"],
      });
    }
    const validTrashState =
      (page.status === "active" &&
        page.trashedAt === null &&
        page.trashBatchId === null) ||
      (page.status === "trashed" &&
        page.trashedAt !== null &&
        page.trashBatchId !== null);
    if (!validTrashState) {
      context.addIssue({
        code: "custom",
        message: "Page trash metadata does not match its status",
        path: ["pages", index, "status"],
      });
    }
  }
  checkParentCycles(manifest.pages, context);
  checkReferences(manifest.acl, "pageId", pageIds, "acl", context);
  checkReferences(manifest.acl, "userId", memberIds, "acl", context);
  checkReferences(manifest.pageTags, "pageId", pageIds, "pageTags", context);
  checkReferences(manifest.pageTags, "tagId", tagIds, "pageTags", context);
  checkReferences(manifest.links, "sourcePageId", pageIds, "links", context);
  checkReferences(manifest.aliases, "pageId", pageIds, "aliases", context);
  checkReferences(manifest.comments, "pageId", pageIds, "comments", context);
  checkReferences(
    manifest.comments,
    "authorId",
    memberIds,
    "comments",
    context,
  );
  const memberEmails = new Map(
    manifest.members.map((member) => [member.id, member.email.toLowerCase()]),
  );
  for (const [index, entry] of manifest.acl.entries()) {
    if (memberEmails.get(entry.userId) !== entry.userEmail.toLowerCase()) {
      context.addIssue({
        code: "custom",
        message: "ACL userEmail does not match its exported member",
        path: ["acl", index, "userEmail"],
      });
    }
  }
  for (const [index, comment] of manifest.comments.entries()) {
    if (
      memberEmails.get(comment.authorId) !== comment.authorEmail.toLowerCase()
    ) {
      context.addIssue({
        code: "custom",
        message: "Comment authorEmail does not match its exported member",
        path: ["comments", index, "authorEmail"],
      });
    }
  }
  for (const [index, link] of manifest.links.entries()) {
    if (link.targetPageId !== null && !pageIds.has(link.targetPageId)) {
      context.addIssue({
        code: "custom",
        message: "Link targetPageId does not exist in the manifest",
        path: ["links", index, "targetPageId"],
      });
    }
  }
  for (const [index, asset] of manifest.assets.entries()) {
    if (asset.pageId !== null && !pageIds.has(asset.pageId)) {
      context.addIssue({
        code: "custom",
        message: "Asset pageId does not exist in the manifest",
        path: ["assets", index, "pageId"],
      });
    }
  }
}

function checkCount(
  manifest: PortableManifest,
  key: keyof PortableManifest["counts"],
  context: z.RefinementCtx,
): void {
  if (manifest.counts[key] !== manifest[key].length) {
    context.addIssue({
      code: "custom",
      message: `Manifest ${key} count does not match its records`,
      path: ["counts", key],
    });
  }
}

function uniqueValues(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
): Set<string> {
  const result = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (result.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate manifest identifier: ${value}`,
        path: [...path, index],
      });
    }
    result.add(value);
  }
  return result;
}

function checkReferences<T extends Record<K, string>, K extends keyof T>(
  records: readonly T[],
  key: K,
  known: ReadonlySet<string>,
  path: string,
  context: z.RefinementCtx,
): void {
  for (const [index, record] of records.entries()) {
    if (!known.has(record[key])) {
      context.addIssue({
        code: "custom",
        message: `Manifest reference does not exist: ${record[key]}`,
        path: [path, index, String(key)],
      });
    }
  }
}

function checkParentCycles(
  pages: PortableManifest["pages"],
  context: z.RefinementCtx,
): void {
  const parents = new Map(pages.map((page) => [page.id, page.parentId]));
  for (const [index, page] of pages.entries()) {
    const seen = new Set<string>();
    let current: string | null = page.id;
    while (current !== null) {
      if (seen.has(current)) {
        context.addIssue({
          code: "custom",
          message: "Page hierarchy contains a cycle",
          path: ["pages", index, "parentId"],
        });
        break;
      }
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
}

function isPortablePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}
