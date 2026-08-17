import { z } from "zod";

import type {
  SearchCandidate,
  SearchRequest,
  SearchResponse,
} from "./contracts";
import type { SearchCandidateAuthorizer } from "./authorizer";

const candidateMetadataSchema = z.object({
  workspace_id: z.string().min(1),
  page_id: z.string().min(1),
  content_hash: z.string().min(1),
});

interface SearchChunk {
  id: string;
  score: number;
  text: string;
  item: {
    key: string;
    metadata?: Record<string, unknown>;
  };
}

export interface AiSearchClient {
  search(request: AiSearchSearchRequest): Promise<{
    chunks: SearchChunk[];
  }>;
}

const hybridRetrievalVariants: readonly AiSearchOptions["retrieval"][] = [
  { retrieval_type: "hybrid", fusion_method: "rrf" },
  { retrieval_type: "hybrid", fusion_method: "max" },
  { retrieval_type: "vector" },
  { retrieval_type: "keyword", keyword_match_mode: "or" },
];

export class WikiSearchService {
  public constructor(
    private readonly searchClient: AiSearchClient,
    private readonly authorizer: SearchCandidateAuthorizer,
  ) {}

  public async search(userId: string, request: SearchRequest): Promise<SearchResponse> {
    const uniqueCandidates = new Map<string, SearchCandidate>();
    const authorized = new Map<string, Awaited<ReturnType<SearchCandidateAuthorizer["authorize"]>>>();

    for (const retrieval of retrievalVariants(request.mode ?? "hybrid")) {
      const response = await this.searchClient.search({
        query: request.query,
        ai_search_options: {
          retrieval: {
            ...retrieval,
            max_num_results: 50,
            filters: { workspace_id: request.workspaceId },
            return_on_failure: true,
          },
          reranking: {
            enabled: true,
            model: "@cf/baai/bge-reranker-base",
          },
        },
      });

      for (const chunk of response.chunks) {
        const candidate = toCandidate(chunk);
        if (
          candidate !== null &&
          candidate.workspaceId === request.workspaceId &&
          !uniqueCandidates.has(candidate.chunkId)
        ) {
          uniqueCandidates.set(candidate.chunkId, candidate);
        }
      }

      const unseen = [...uniqueCandidates.values()].filter(
        (candidate) => !authorized.has(candidate.chunkId),
      );
      const decisions = await Promise.all(
        unseen.map(async (candidate) => ({
          candidate,
          result: await this.authorizer.authorize(userId, candidate, request),
        })),
      );
      for (const decision of decisions) {
        authorized.set(decision.candidate.chunkId, decision.result);
      }

      if ([...authorized.values()].filter((value) => value !== null).length >= request.limit) {
        break;
      }
    }

    const results = [...authorized.values()]
      .filter((value) => value !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit);

    return {
      query: request.query,
      results,
      candidateCount: uniqueCandidates.size,
    };
  }
}

function retrievalVariants(
  mode: SearchRequest["mode"],
): readonly AiSearchOptions["retrieval"][] {
  if (mode === "keyword") {
    return [{ retrieval_type: "keyword", keyword_match_mode: "or" }];
  }
  if (mode === "semantic") return [{ retrieval_type: "vector" }];
  return hybridRetrievalVariants;
}

function toCandidate(chunk: SearchChunk): SearchCandidate | null {
  const metadata = candidateMetadataSchema.safeParse(chunk.item.metadata);
  if (!metadata.success) {
    return null;
  }

  return {
    chunkId: chunk.id,
    key: chunk.item.key,
    pageId: metadata.data.page_id,
    workspaceId: metadata.data.workspace_id,
    contentHash: metadata.data.content_hash,
    text: chunk.text,
    score: chunk.score,
  };
}
