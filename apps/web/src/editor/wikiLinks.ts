import type { SearchHit, WikiApi } from "../api";

export interface WikiLinkCandidate {
  pageId: string;
  title: string;
  path: string;
}

export interface WikiLinkSuggestionProvider {
  search(query: string, signal: AbortSignal): Promise<WikiLinkCandidate[]>;
}

export function createApiWikiLinkSuggestionProvider(api: WikiApi): WikiLinkSuggestionProvider {
  return {
    async search(query, signal) {
      const response = await api.search({ query, mode: "keyword", limit: 8 }, signal);
      return response.hits.map((hit: SearchHit) => ({ pageId: hit.pageId, title: hit.title, path: hit.path }));
    },
  };
}

export function extractWikiLinkQuery(markdown: string, cursor = markdown.length) {
  const beforeCursor = markdown.slice(0, cursor);
  const match = /\[\[([^\]\n]*)$/.exec(beforeCursor);
  return match?.[1] ?? null;
}

export function completeWikiLink(markdown: string, candidate: WikiLinkCandidate, cursor = markdown.length) {
  const beforeCursor = markdown.slice(0, cursor);
  const match = /\[\[([^\]\n]*)$/.exec(beforeCursor);
  if (!match) return { markdown, cursor };
  const needsQualifiedPath = candidate.path.split("/").filter(Boolean).length > 1;
  const target = needsQualifiedPath ? `${candidate.path.replace(/^\//, "")}|${candidate.title}` : candidate.title;
  const insertion = `[[${target}]]`;
  const next = `${beforeCursor.slice(0, match.index)}${insertion}${markdown.slice(cursor)}`;
  return { markdown: next, cursor: match.index + insertion.length };
}
