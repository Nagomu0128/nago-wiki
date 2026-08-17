import { z } from "zod";

export * from "./auth";
export * from "./errors";
export * from "./search";
export * from "./wiki";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("nago-wiki"),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
