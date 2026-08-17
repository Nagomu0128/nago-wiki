import { describe, expect, it, vi } from "vitest";

import type { SearchCandidateAuthorizer } from "../../src/ai/authorizer";
import { WikiSearchService, type AiSearchClient } from "../../src/ai/search-service";

describe("WikiSearchService", () => {
  it("returns only candidates re-authorized against canonical state", async () => {
    const search = vi.fn<AiSearchClient["search"]>().mockResolvedValue({
      chunks: [
        candidate("allowed", "page-1", "hash-1", 0.9),
        candidate("denied", "page-2", "hash-2", 0.95),
      ],
    });
    const authorize = vi.fn<SearchCandidateAuthorizer["authorize"]>(
      (_userId, value) =>
        Promise.resolve(value.pageId === "page-1"
          ? {
              chunkId: value.chunkId,
              pageId: value.pageId,
              title: "Allowed page",
              path: "/pages/page-1",
              url: "https://wiki.example/pages/page-1",
              snippet: value.text,
              score: value.score,
              contentHash: value.contentHash,
            }
          : null),
    );
    const service = new WikiSearchService({ search }, { authorize });

    const result = await service.search("user-1", {
      query: "secret",
      workspaceId: "workspace-1",
      limit: 1,
    });

    expect(result.results.map((value) => value.pageId)).toEqual(["page-1"]);
    expect(result.candidateCount).toBe(2);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("expands retrieval when ACL filtering leaves too few results", async () => {
    const search = vi
      .fn<AiSearchClient["search"]>()
      .mockResolvedValueOnce({
        chunks: [candidate("denied", "page-1", "hash-1", 0.9)],
      })
      .mockResolvedValueOnce({
        chunks: [candidate("allowed", "page-2", "hash-2", 0.8)],
      });
    const authorize = vi.fn<SearchCandidateAuthorizer["authorize"]>(
      (_userId, value) =>
        Promise.resolve(value.chunkId === "allowed"
          ? {
              chunkId: value.chunkId,
              pageId: value.pageId,
              title: "Allowed page",
              path: "/pages/page-2",
              url: "https://wiki.example/pages/page-2",
              snippet: value.text,
              score: value.score,
              contentHash: value.contentHash,
            }
          : null),
    );
    const service = new WikiSearchService({ search }, { authorize });

    const result = await service.search("user-1", {
      query: "question",
      workspaceId: "workspace-1",
      limit: 1,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(result.results[0]?.pageId).toBe("page-2");
  });

  it("discards hits with malformed or cross-workspace metadata", async () => {
    const search = vi.fn<AiSearchClient["search"]>().mockResolvedValue({
      chunks: [
        {
          id: "malformed",
          score: 1,
          text: "bad",
          item: { key: "bad", metadata: { page_id: "page-1" } },
        },
        candidate("other", "page-2", "hash-2", 0.9, "workspace-2"),
      ],
    });
    const authorize = vi.fn<SearchCandidateAuthorizer["authorize"]>();
    const service = new WikiSearchService({ search }, { authorize });

    const result = await service.search("user-1", {
      query: "question",
      workspaceId: "workspace-1",
      limit: 1,
    });

    expect(result.results).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });
});

function candidate(
  id: string,
  pageId: string,
  contentHash: string,
  score: number,
  workspaceId = "workspace-1",
) {
  return {
    id,
    score,
    text: `content for ${pageId}`,
    item: {
      key: `w/${workspaceId}/p/${pageId}.md`,
      metadata: {
        workspace_id: workspaceId,
        page_id: pageId,
        content_hash: contentHash,
      },
    },
  };
}
