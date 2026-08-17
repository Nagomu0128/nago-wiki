import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const pagePermissionSchema = z.enum(["owner", "editor", "viewer", "none"]);
export type PagePermission = z.infer<typeof pagePermissionSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("nago-wiki"),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
