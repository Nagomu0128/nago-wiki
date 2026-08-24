import { z } from "zod";

import { pageAccessModeSchema } from "./wiki";

const nullableUuidSchema = z.uuid().nullable();

export const wikiTagSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
});
export type WikiTag = z.infer<typeof wikiTagSchema>;

export const replacePageTagsRequestSchema = z.object({
  names: z.array(z.string().trim().min(1).max(100)).max(50),
});
export type ReplacePageTagsRequest = z.infer<
  typeof replacePageTagsRequestSchema
>;

export const pageNavigationItemSchema = z.object({
  id: z.uuid(),
  parentId: nullableUuidSchema,
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  accessMode: pageAccessModeSchema,
  updatedAt: z.iso.datetime(),
});
export type PageNavigationItem = z.infer<typeof pageNavigationItemSchema>;

export const recentPageItemSchema = pageNavigationItemSchema.extend({
  lastViewedAt: z.iso.datetime(),
});
export type RecentPageItem = z.infer<typeof recentPageItemSchema>;

export const favoritePageItemSchema = pageNavigationItemSchema.extend({
  favoritedAt: z.iso.datetime(),
});
export type FavoritePageItem = z.infer<typeof favoritePageItemSchema>;

export const trashedPageItemSchema = pageNavigationItemSchema.extend({
  trashedAt: z.iso.datetime(),
  restorable: z.boolean(),
});
export type TrashedPageItem = z.infer<typeof trashedPageItemSchema>;

export const recentPagesResponseSchema = z.object({
  pages: z.array(recentPageItemSchema),
});
export type RecentPagesResponse = z.infer<typeof recentPagesResponseSchema>;

export const favoritePagesResponseSchema = z.object({
  pages: z.array(favoritePageItemSchema),
});
export type FavoritePagesResponse = z.infer<typeof favoritePagesResponseSchema>;

export const trashedPagesListResponseSchema = z.object({
  pages: z.array(trashedPageItemSchema),
});
export type TrashedPagesListResponse = z.infer<
  typeof trashedPagesListResponseSchema
>;

export const pageFavoriteResponseSchema = z.object({
  favorite: z.boolean(),
});
export type PageFavoriteResponse = z.infer<typeof pageFavoriteResponseSchema>;

export const pageTagsResponseSchema = z.object({
  tags: z.array(wikiTagSchema),
});
export type PageTagsResponse = z.infer<typeof pageTagsResponseSchema>;

export const backlinkPageSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(500),
  path: z.string().min(1).max(4096),
  url: z.url(),
});
export type BacklinkPage = z.infer<typeof backlinkPageSchema>;

export const backlinksResponseSchema = z.object({
  pages: z.array(backlinkPageSchema),
});
export type BacklinksResponse = z.infer<typeof backlinksResponseSchema>;
