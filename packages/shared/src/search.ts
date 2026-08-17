import { z } from "zod";

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  mode: z.enum(["keyword", "semantic", "hybrid"]).optional().default("hybrid"),
  parentPageId: z.uuid().optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().max(2_000).optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchHitSchema = z.object({
  pageId: z.uuid(),
  title: z.string(),
  path: z.string(),
  url: z.string(),
  snippet: z.string(),
  score: z.number(),
  source: z.enum(["title", "keyword", "semantic"]),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
  cursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
