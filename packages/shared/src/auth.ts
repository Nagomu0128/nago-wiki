import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const userStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const externalIdentityProviderSchema = z.enum([
  "cloudflare_access",
  "google",
  "discord",
  "line",
]);
export type ExternalIdentityProvider = z.infer<
  typeof externalIdentityProviderSchema
>;

export const userSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  email: z.email(),
  displayName: z.string().trim().min(1).max(200),
  role: workspaceRoleSchema,
  status: userStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const authenticatedIdentitySchema = userSchema.pick({
  id: true,
  workspaceId: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
}).extend({
  subject: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type AuthenticatedIdentity = z.infer<
  typeof authenticatedIdentitySchema
>;
