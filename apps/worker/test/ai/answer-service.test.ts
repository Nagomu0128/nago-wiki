import { describe, expect, it, vi } from "vitest";

import type { AnswerModel } from "../../src/ai/answer-service";
import { WikiAnswerService } from "../../src/ai/answer-service";
import type { WikiSearchService } from "../../src/ai/search-service";

describe("WikiAnswerService", () => {
  it("does not call the model for empty wiki-only retrieval", async () => {
    const search = vi.fn<WikiSearchService["search"]>().mockResolvedValue({
      query: "unknown",
      results: [],
      candidateCount: 0,
    });
    const generate = vi.fn<AnswerModel["generate"]>();
    const service = new WikiAnswerService(
      { search } as unknown as WikiSearchService,
      { generate },
    );

    const result = await service.answer("user-1", {
      query: "unknown",
      workspaceId: "workspace-1",
      knowledgeMode: "wiki_only",
      maxCitations: 8,
    });

    expect(result.state).toBe("insufficient");
    expect(result.citations).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("drops model-invented citations", async () => {
    const search = vi.fn<WikiSearchService["search"]>().mockResolvedValue({
      query: "known",
      candidateCount: 1,
      results: [
        {
          chunkId: "real",
          pageId: "page-1",
          title: "Page",
          path: "/pages/page-1",
          url: "https://wiki.example/pages/page-1",
          snippet: "trusted evidence",
          score: 0.9,
          contentHash: "hash-1",
        },
      ],
    });
    const generate = vi.fn<AnswerModel["generate"]>().mockResolvedValue({
      answer: "Answer",
      state: "wiki",
      citations: [
        { chunkId: "invented", quote: "not real" },
        { chunkId: "real", quote: "trusted evidence" },
      ],
    });
    const service = new WikiAnswerService(
      { search } as unknown as WikiSearchService,
      { generate },
    );

    const result = await service.answer("user-1", {
      query: "known",
      workspaceId: "workspace-1",
      knowledgeMode: "wiki_only",
      maxCitations: 8,
    });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.chunkId).toBe("real");
    expect(generate).toHaveBeenCalledWith(
      "user-1",
      "known",
      "wiki_only",
      expect.any(Array),
      undefined,
    );
  });
});
