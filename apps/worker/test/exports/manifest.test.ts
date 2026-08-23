import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";

import {
  buildPortableManifest,
  parsePortableManifest,
  type PortableManifestInput,
} from "../../src/exports/manifest";
import {
  buildCentralDirectory,
  buildStoredLocalRecord,
  crc32,
  planStoredZip,
} from "../../src/exports/zip";

describe("portable export manifest", () => {
  it("contains the logical metadata and hashes needed to restore a workspace", () => {
    const input: PortableManifestInput = {
      exportId: "export-1",
      workspaceId: "workspace-1",
      exportedAt: "2026-08-18T00:00:00.000Z",
      pages: [
        {
          id: "page-1",
          parentId: null,
          slug: "home",
          title: "Home",
          revision: 2,
          contentHash: "a".repeat(64),
          accessMode: "restricted",
          status: "active",
          trashedAt: null,
          trashBatchId: null,
          createdBy: "owner-1",
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
          bodyBytes: 6,
          file: "pages/page-1.md",
        },
      ],
      assets: [
        {
          sourceKey: "assets/workspace-1/page-1/asset-1/figure.png",
          pageId: "page-1",
          assetId: "asset-1",
          filename: "figure.png",
          file: "assets/00000001/figure.png",
          size: 3,
          etag: "etag-1",
          uploadedAt: "2026-08-18T00:00:00.000Z",
          contentType: "image/png",
          customMetadata: { caption: "diagram" },
        },
      ],
      acl: [
        {
          pageId: "page-1",
          userId: "viewer-1",
          userEmail: "viewer@example.com",
          permission: "viewer",
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      tags: [
        {
          id: "tag-1",
          name: "Guide",
          normalizedName: "guide",
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      pageTags: [{ pageId: "page-1", tagId: "tag-1" }],
      links: [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          rawTarget: "Future",
          sourceRevision: 2,
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      aliases: [
        {
          normalizedPath: "/old-home",
          pageId: "page-1",
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      comments: [],
    };
    const hash = "b".repeat(64);
    const asset = input.assets[0];
    if (asset === undefined) throw new Error("Missing test asset");
    const manifest: unknown = JSON.parse(
      buildPortableManifest(input, new Map([[asset.sourceKey, hash]])),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      counts: { pages: 1, assets: 1, acl: 1, links: 1 },
      pages: [
        {
          id: "page-1",
          createdBy: "owner-1",
          sha256: "a".repeat(64),
          size: 6,
        },
      ],
      assets: [{ pageId: "page-1", sha256: hash }],
      acl: [{ userEmail: "viewer@example.com", permission: "viewer" }],
      tags: [{ normalizedName: "guide" }],
      pageTags: [{ pageId: "page-1", tagId: "tag-1" }],
      links: [{ rawTarget: "Future" }],
      aliases: [{ normalizedPath: "/old-home" }],
    });
  });

  it("restores pages, assets, and links into an empty logical workspace", async () => {
    const pageBody = new TextEncoder().encode("# Home\n");
    const assetBody = new Uint8Array([1, 2, 3, 4]);
    const pageHash = await sha256(pageBody);
    const assetHash = await sha256(assetBody);
    const input: PortableManifestInput = {
      exportId: "restore-export",
      workspaceId: "source-workspace",
      exportedAt: "2026-08-18T00:00:00.000Z",
      pages: [
        {
          id: "home",
          parentId: null,
          slug: "home",
          title: "Home",
          revision: 1,
          contentHash: pageHash,
          accessMode: "workspace",
          status: "active",
          trashedAt: null,
          trashBatchId: null,
          createdBy: "owner",
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
          bodyBytes: pageBody.byteLength,
          file: "pages/home.md",
        },
      ],
      assets: [
        {
          sourceKey: "assets/source-workspace/home/image-1/image.png",
          pageId: "home",
          assetId: "image-1",
          filename: "image.png",
          file: "assets/00000001/image.png",
          size: assetBody.byteLength,
          etag: "source-etag",
          uploadedAt: "2026-08-18T00:00:00.000Z",
          contentType: "image/png",
          customMetadata: {},
        },
      ],
      acl: [],
      tags: [],
      pageTags: [],
      links: [
        {
          sourcePageId: "home",
          targetPageId: "home",
          rawTarget: "Home",
          sourceRevision: 1,
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      aliases: [],
      comments: [],
    };
    const manifestBytes = new TextEncoder().encode(
      buildPortableManifest(
        input,
        new Map([[input.assets[0]?.sourceKey ?? "", assetHash]]),
      ),
    );
    const files = [
      { name: input.pages[0]?.file ?? "", data: pageBody },
      { name: input.assets[0]?.file ?? "", data: assetBody },
      { name: "manifest.json", data: manifestBytes },
    ];
    const plan = planStoredZip(
      files.map((file) => ({ name: file.name, size: file.data.byteLength })),
    );
    const archive = concatenate([
      ...files.map((file, index) =>
        buildStoredLocalRecord(requiredAt(plan.entries, index), file.data),
      ),
      buildCentralDirectory(
        plan,
        new Map(files.map((file) => [file.name, crc32(file.data)])),
      ),
    ]);

    const extracted = unzipSync(archive);
    const manifest = parsePortableManifest(
      JSON.parse(
        new TextDecoder().decode(requiredFile(extracted, "manifest.json")),
      ),
    );
    const restoredPages = new Map(
      await Promise.all(
        manifest.pages.map(async (page) => {
          const body = requiredFile(extracted, page.file);
          expect(await sha256(body)).toBe(page.sha256);
          return [page.id, new TextDecoder().decode(body)] as const;
        }),
      ),
    );
    const restoredAssets = new Map(
      await Promise.all(
        manifest.assets.map(async (asset) => {
          const body = requiredFile(extracted, asset.file);
          expect(await sha256(body)).toBe(asset.sha256);
          return [asset.sourceKey, body] as const;
        }),
      ),
    );

    expect(restoredPages).toEqual(new Map([["home", "# Home\n"]]));
    expect(restoredAssets.size).toBe(1);
    expect(manifest.links).toMatchObject([
      { sourcePageId: "home", targetPageId: "home", rawTarget: "Home" },
    ]);
  });

  it("rejects broken graph references and unsafe archive paths", () => {
    const manifest: unknown = JSON.parse(
      buildPortableManifest(
        {
          exportId: "invalid-export",
          workspaceId: "workspace",
          exportedAt: "2026-08-18T00:00:00.000Z",
          pages: [
            {
              id: "page",
              parentId: "missing-parent",
              slug: "page",
              title: "Page",
              revision: 1,
              contentHash: "a".repeat(64),
              accessMode: "workspace",
              status: "active",
              trashedAt: null,
              trashBatchId: null,
              createdBy: "owner",
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
              bodyBytes: 0,
              file: "../page.md",
            },
          ],
          assets: [],
          acl: [],
          tags: [],
          pageTags: [],
          links: [],
          aliases: [],
          comments: [],
        },
        new Map(),
      ),
    );

    expect(() => parsePortableManifest(manifest)).toThrow();
  });
});

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing test ZIP entry");
  return value;
}

function requiredFile(
  files: Readonly<Record<string, Uint8Array>>,
  name: string,
): Uint8Array {
  const value = files[name];
  if (value === undefined) throw new Error(`Missing extracted file ${name}`);
  return value;
}
