import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "AUTH_CONFIGURATION_ERROR",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "CONTENT_LENGTH_REQUIRED",
  "ASSET_TOO_LARGE",
  "UNSUPPORTED_ASSET_TYPE",
  "INVALID_ASSET",
  "MEMBER_NOT_FOUND",
  "MEMBER_UPDATE_CONFLICT",
  "LAST_ACTIVE_OWNER",
  "IDEMPOTENCY_CONFLICT",
  "PAGE_NOT_FOUND",
  "PAGE_NOT_RESTRICTED",
  "ACL_REVISION_CONFLICT",
  "BOT_CHANNEL_NOT_FOUND",
  "BOT_CHANNEL_UPDATE_CONFLICT",
  "PAGE_SLUG_CONFLICT",
  "REVISION_CONFLICT",
  "REALTIME_FLUSH_FAILED",
  "INVALID_PAGE_MOVE",
  "VERSION_NOT_FOUND",
  "VERSION_CONTENT_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
