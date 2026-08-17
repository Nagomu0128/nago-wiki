import { z } from "zod";

export const indexPageJobSchema = z.object({
  type: z.literal("index-page"),
  jobId: z.string().min(1),
  workspaceId: z.string().min(1),
  pageId: z.string().min(1),
  desiredHash: z.string().min(1),
});

export const asyncJobSchema = z.discriminatedUnion("type", [indexPageJobSchema]);
export type AsyncJob = z.infer<typeof asyncJobSchema>;
export type IndexPageJob = z.infer<typeof indexPageJobSchema>;
