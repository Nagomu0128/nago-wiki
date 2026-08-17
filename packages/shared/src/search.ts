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

export const knowledgeModeSchema = z.enum(["wiki_only", "wiki_plus_general"]);
export type KnowledgeMode = z.infer<typeof knowledgeModeSchema>;

export const answerRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  knowledgeMode: knowledgeModeSchema.optional().default("wiki_plus_general"),
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20_000),
      }),
    )
    .max(20)
    .optional(),
});
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

export const answerResponseSchema = z.object({
  state: z.enum(["wiki", "mixed", "general", "insufficient"]),
  answerMarkdown: z.string(),
  citations: z.array(
    z.object({
      id: z.string(),
      pageId: z.uuid(),
      title: z.string(),
      path: z.string(),
      url: z.string(),
      snippet: z.string(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  requestId: z.string(),
});
export type AnswerResponse = z.infer<typeof answerResponseSchema>;
