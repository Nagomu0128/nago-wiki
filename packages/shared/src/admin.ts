import { z } from "zod";

import { userStatusSchema, workspaceRoleSchema } from "./auth";

export const botProviderSchema = z.enum(["discord", "line"]);
export type BotProvider = z.infer<typeof botProviderSchema>;

export const externalBotChannelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u, "Unsupported channel id");

export const adminMemberSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1).max(200),
  role: workspaceRoleSchema,
  status: userStatusSchema,
  linkedBotProviders: z.array(botProviderSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminMember = z.infer<typeof adminMemberSchema>;

export const updateAdminMemberRequestSchema = z
  .object({
    role: workspaceRoleSchema.optional(),
    status: z.literal("suspended").optional(),
    expectedUpdatedAt: z.iso.datetime(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "A role or status change is required",
  });
export type UpdateAdminMemberRequest = z.infer<
  typeof updateAdminMemberRequestSchema
>;

export const pageAclPermissionSchema = z.enum(["editor", "viewer"]);
export type PageAclPermission = z.infer<typeof pageAclPermissionSchema>;

export const pageAclEntrySchema = z.object({
  userId: z.uuid(),
  displayName: z.string().min(1).max(200),
  email: z.email(),
  permission: pageAclPermissionSchema,
});
export type PageAclEntry = z.infer<typeof pageAclEntrySchema>;

export const pageAclResponseSchema = z.object({
  pageId: z.uuid(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
  entries: z.array(pageAclEntrySchema),
});
export type PageAclResponse = z.infer<typeof pageAclResponseSchema>;

export const replacePageAclRequestSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    entries: z
      .array(
        z.object({
          userId: z.uuid(),
          permission: pageAclPermissionSchema,
        }),
      )
      .max(200),
  })
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.userId)).size === value.entries.length,
    { message: "Each member may appear only once" },
  );
export type ReplacePageAclRequest = z.infer<
  typeof replacePageAclRequestSchema
>;

export const botChannelSchema = z.object({
  provider: botProviderSchema,
  externalChannelId: externalBotChannelIdSchema,
  displayName: z.string().trim().min(1).max(200).nullable(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BotChannel = z.infer<typeof botChannelSchema>;

export const botProviderSettingsSchema = z.object({
  provider: botProviderSchema,
  enabled: z.boolean(),
  channels: z.array(botChannelSchema),
});
export type BotProviderSettings = z.infer<typeof botProviderSettingsSchema>;

export const botSettingsResponseSchema = z.object({
  providers: z.array(botProviderSettingsSchema),
});
export type BotSettingsResponse = z.infer<typeof botSettingsResponseSchema>;

export const updateBotProviderRequestSchema = z.object({ enabled: z.boolean() });
export type UpdateBotProviderRequest = z.infer<
  typeof updateBotProviderRequestSchema
>;

export const createBotChannelRequestSchema = z.object({
  provider: botProviderSchema,
  externalChannelId: externalBotChannelIdSchema,
  displayName: z.string().trim().min(1).max(200).nullable().optional().default(null),
  enabled: z.boolean().optional().default(true),
});
export type CreateBotChannelRequest = z.infer<
  typeof createBotChannelRequestSchema
>;

export const updateBotChannelRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.displayName !== undefined || value.enabled !== undefined, {
    message: "A channel change is required",
  });
export type UpdateBotChannelRequest = z.infer<
  typeof updateBotChannelRequestSchema
>;

export const linkedBotAccountSchema = z.object({
  provider: botProviderSchema,
  externalSubjectMasked: z.string(),
  linkedAt: z.iso.datetime(),
});
export type LinkedBotAccount = z.infer<typeof linkedBotAccountSchema>;
