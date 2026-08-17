import { z } from "zod";

export const knowledgeModeSchema = z.enum(["wiki_only", "wiki_plus_general"]);
export type KnowledgeMode = z.infer<typeof knowledgeModeSchema>;

const optionalIdSchema = z.string().min(1).max(128).optional();

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  workspaceId: z.string().min(1).max(128),
  parentPageId: optionalIdSchema,
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const answerRequestSchema = searchRequestSchema
  .omit({ limit: true })
  .extend({
    knowledgeMode: knowledgeModeSchema.default("wiki_plus_general"),
    maxCitations: z.number().int().min(1).max(12).default(8),
  });
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

export const authorizedChunkSchema = z.object({
  chunkId: z.string(),
  pageId: z.string(),
  title: z.string(),
  path: z.string(),
  url: z.string(),
  snippet: z.string(),
  score: z.number(),
  contentHash: z.string(),
});
export type AuthorizedChunk = z.infer<typeof authorizedChunkSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(authorizedChunkSchema),
  candidateCount: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const answerStateSchema = z.enum([
  "wiki",
  "mixed",
  "general",
  "insufficient",
]);
export type AnswerState = z.infer<typeof answerStateSchema>;

export const citationSchema = z.object({
  chunkId: z.string(),
  pageId: z.string(),
  title: z.string(),
  path: z.string(),
  url: z.string(),
  quote: z.string().max(500),
});
export type Citation = z.infer<typeof citationSchema>;

export const answerResponseSchema = z.object({
  answer: z.string(),
  state: answerStateSchema,
  citations: z.array(citationSchema),
});
export type AnswerResponse = z.infer<typeof answerResponseSchema>;

export interface SearchCandidate {
  chunkId: string;
  key: string;
  pageId: string;
  workspaceId: string;
  contentHash: string;
  text: string;
  score: number;
}
