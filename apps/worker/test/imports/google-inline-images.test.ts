import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  finalizeGoogleImportAssets,
  importGoogleInlineImages,
  replaceGoogleInlineObjectLinks,
} from "../../src/imports/google-inline-images";

describe("Google Docs inline image import", () => {
  it("sniffs, stages, and renders a protected page asset", async () => {
    const result = await importGoogleInlineImages({
      files: env.FILES,
      workspaceId: "workspace-1",
      importId: "import-1",
      targetPageId: "0198f8dd-a20b-7000-8000-000000000001",
      images: [{
        objectId: "image-1",
        contentUri: "https://images.example/short-lived-token",
        altText: "System ] diagram",
      }],
      fetchImage: () => Promise.resolve(new Response(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
        { headers: { "content-type": "application/octet-stream" } },
      )),
    });

    expect(result.warnings).toEqual([]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.contentType).toBe("image/png");
    expect(result.assets[0]?.stagingKey).toMatch(
      /^imports\/workspace-1\/import-1\/assets\/[0-9a-f-]{36}\/google-image-1\.png$/u,
    );
    expect(replaceGoogleInlineObjectLinks(
      "![Google Docs image](google-inline-object:image-1)",
      ["image-1"],
      result.assets,
    )).toContain("![System \\] diagram](/api/v1/pages/");

    await finalizeGoogleImportAssets({
      files: env.FILES,
      workspaceId: "workspace-1",
      importId: "import-1",
      pageId: "0198f8dd-a20b-7000-8000-000000000001",
      uploadedBy: "user-1",
      assets: result.assets,
    });
    const final = await env.FILES.get(result.assets[0]?.finalKey ?? "missing");
    expect(final?.size).toBe(9);
    expect(final?.httpMetadata?.contentType).toBe("image/png");
    expect(final?.customMetadata?.uploadedBy).toBe("user-1");
  });

  it("removes unresolved bearer-like image placeholders", () => {
    expect(replaceGoogleInlineObjectLinks(
      "before ![Google Docs image](google-inline-object:missing) after",
      ["missing"],
      [],
    )).toBe("before _[Google Docs image could not be imported]_ after");
  });
});
