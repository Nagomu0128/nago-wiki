import { z } from "zod";

const nullableUuidSchema = z.uuid().nullable();

export const pagePermissionSchema = z.enum([
  "owner",
  "editor",
  "viewer",
  "none",
]);
export type PagePermission = z.infer<typeof pagePermissionSchema>;

export const pageAccessModeSchema = z.enum(["workspace", "restricted"]);
export type PageAccessMode = z.infer<typeof pageAccessModeSchema>;

export const pageStatusSchema = z.enum(["active", "trashed"]);
export type PageStatus = z.infer<typeof pageStatusSchema>;

export const pageSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: nullableUuidSchema,
  slug: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  bodyMd: z.string().max(1_048_576),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  accessMode: pageAccessModeSchema,
  status: pageStatusSchema,
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  trashedAt: z.iso.datetime().nullable(),
});
export type Page = z.infer<typeof pageSchema>;

export const pageWithPermissionSchema = z.object({
  page: pageSchema,
  permission: pagePermissionSchema.exclude(["none"]),
  tags: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1).max(100),
    }),
  ),
});
export type PageWithPermission = z.infer<
  typeof pageWithPermissionSchema
>;

export const createPageRequestSchema = z.object({
  parentId: nullableUuidSchema.optional().default(null),
  slug: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(500),
  bodyMd: z.string().max(1_048_576).optional().default(""),
  accessMode: pageAccessModeSchema.optional().default("workspace"),
});
export type CreatePageRequest = z.infer<typeof createPageRequestSchema>;

export const updatePageRequestSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(500).optional(),
    bodyMd: z.string().max(1_048_576).optional(),
  })
  .refine((value) => value.title !== undefined || value.bodyMd !== undefined, {
    message: "At least one editable field is required",
  });
export type UpdatePageRequest = z.infer<typeof updatePageRequestSchema>;

export const movePageRequestSchema = z.object({
  parentId: nullableUuidSchema,
  slug: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(500).optional(),
});
export type MovePageRequest = z.infer<typeof movePageRequestSchema>;

export const trashedPagesResponseSchema = z.object({
  status: z.literal("trashed"),
  pageIds: z.array(z.uuid()),
});
export type TrashedPagesResponse = z.infer<
  typeof trashedPagesResponseSchema
>;

export interface PageTreeNode {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  accessMode: PageAccessMode;
  updatedAt: string;
  children: PageTreeNode[];
}

export const pageTreeNodeSchema: z.ZodType<PageTreeNode> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    parentId: nullableUuidSchema,
    slug: z.string(),
    title: z.string(),
    accessMode: pageAccessModeSchema,
    updatedAt: z.iso.datetime(),
    children: z.array(pageTreeNodeSchema),
  }),
);

export const pageTreeResponseSchema = z.object({
  pages: z.array(pageTreeNodeSchema),
});
export type PageTreeResponse = z.infer<typeof pageTreeResponseSchema>;

export const pageVersionReasonSchema = z.enum([
  "create",
  "edit",
  "move",
  "restore",
  "import",
  "manual",
]);
export type PageVersionReason = z.infer<typeof pageVersionReasonSchema>;

export const pageVersionSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  authorId: z.uuid(),
  reason: pageVersionReasonSchema,
  storageStatus: z.enum(["pending", "ready", "failed"]),
  createdAt: z.iso.datetime(),
});
export type PageVersion = z.infer<typeof pageVersionSchema>;

export const pageVersionsResponseSchema = z.object({
  versions: z.array(pageVersionSchema),
});
export type PageVersionsResponse = z.infer<
  typeof pageVersionsResponseSchema
>;

export const restoreVersionRequestSchema = z.object({
  baseRevision: z.number().int().positive(),
});
export type RestoreVersionRequest = z.infer<
  typeof restoreVersionRequestSchema
>;

export const commentStatusSchema = z.enum(["open", "resolved", "deleted"]);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

export const commentSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  authorId: z.uuid(),
  bodyMd: z.string().min(1).max(65_536),
  status: commentStatusSchema,
  mentionedUserIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Comment = z.infer<typeof commentSchema>;

export const commentsResponseSchema = z.object({
  comments: z.array(commentSchema),
});
export type CommentsResponse = z.infer<typeof commentsResponseSchema>;

export const createCommentRequestSchema = z.object({
  bodyMd: z.string().trim().min(1).max(65_536),
  mentionedUserIds: z.array(z.uuid()).max(50).optional().default([]),
});
export type CreateCommentRequest = z.infer<
  typeof createCommentRequestSchema
>;
