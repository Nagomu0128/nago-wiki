import { z } from "zod";

export * from "./auth";
export * from "./errors";
export * from "./knowledge-organization";
export * from "./search";
export * from "./wiki";
export * from "./portable-import";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("nago-wiki"),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
