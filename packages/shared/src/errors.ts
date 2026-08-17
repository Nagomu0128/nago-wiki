import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "AUTH_CONFIGURATION_ERROR",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "PAGE_NOT_FOUND",
  "PAGE_SLUG_CONFLICT",
  "REVISION_CONFLICT",
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
