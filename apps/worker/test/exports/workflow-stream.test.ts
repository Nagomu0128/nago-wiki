import { env } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  stageArchiveSegment,
  streamStagedRange,
  groupEntries,
  uploadArchivePart,
  type PlanStepResult,
  type StagedArchivePart,
} from "../../src/exports/workflow";
import { buildPortableManifest } from "../../src/exports/manifest";
import { planR2MultipartUpload, planStoredZip } from "../../src/exports/zip";
import { hashMarkdown } from "../../src/core/markdown";
import type { McpRuntimeEnv } from "../../src/mcp/types";

describe("portable export archive streaming", () => {
  it("bounds metadata returned by each staging Workflow step", () => {
    const zip = planStoredZip(
      Array.from({ length: 1_001 }, (_, index) => ({
        name: `pages/${String(index).padStart(5, "0")}.md`,
        size: 0,
      })),
    );

    expect(
      groupEntries(zip).every((group) => group.end - group.start <= 400),
    ).toBe(true);
  });

  it("streams an exact range across staged object boundaries", async () => {
    const encoder = new TextEncoder();
    const objects = new Map([
      ["stage-1", encoder.encode("abcdef")],
      ["stage-2", encoder.encode("ghijkl")],
      ["stage-3", encoder.encode("mnop")],
    ]);
    const bucket = {
      get(key: string, options: { range: { offset: number; length: number } }) {
        const value = objects.get(key);
        if (value === undefined) return Promise.resolve(null);
        const body = value.slice(
          options.range.offset,
          options.range.offset + options.range.length,
        );
        return Promise.resolve({ body: new Response(body).body });
      },
    } as unknown as R2Bucket;
    const stages: StagedArchivePart[] = Array.from(objects, ([key, value]) => ({
      key,
      size: value.byteLength,
      crc32: [],
      assetHashes: [],
    }));
    const chunks: Uint8Array[] = [];

    for await (const chunk of streamStagedRange(bucket, stages, 4, 9)) {
      chunks.push(chunk);
    }

    expect(new TextDecoder().decode(concatenate(chunks))).toBe("efghijklm");
  });

  it("fails closed when a staged object is truncated", async () => {
    const bucket = {
      get() {
        return Promise.resolve({ body: new Response("short").body });
      },
    } as unknown as R2Bucket;
    const stages: StagedArchivePart[] = [
      { key: "stage", size: 10, crc32: [], assetHashes: [] },
    ];

    await expect(
      collect(streamStagedRange(bucket, stages, 0, 10)),
    ).rejects.toThrow("range size");
  });

  it("uploads exact uniform multipart ranges from variable staged objects", async () => {
    const mebibyte = 1024 * 1024;
    const id = crypto.randomUUID();
    const archiveKey = `test-exports/${id}/archive.zip`;
    const stageKeys = [
      `test-exports/${id}/stage-1`,
      `test-exports/${id}/stage-2`,
    ];
    const first = new Uint8Array(6 * mebibyte).fill(0x61);
    const second = new Uint8Array(6 * mebibyte).fill(0x62);
    await Promise.all([
      env.FILES.put(stageKeys[0] ?? "", first),
      env.FILES.put(stageKeys[1] ?? "", second),
    ]);
    const upload = await env.FILES.createMultipartUpload(archiveKey);
    const plan: PlanStepResult = {
      planKey: `test-exports/${id}/plan.json`,
      archiveKey,
      archiveSize: 12 * mebibyte,
      pageCount: 0,
      stageCount: 2,
      partCount: 3,
      partSize: 5 * mebibyte,
    };
    const stages: StagedArchivePart[] = [
      {
        key: stageKeys[0] ?? "",
        size: first.byteLength,
        crc32: [],
        assetHashes: [],
      },
      {
        key: stageKeys[1] ?? "",
        size: second.byteLength,
        crc32: [],
        assetHashes: [],
      },
    ];

    try {
      const parts = [];
      for (let index = 0; index < plan.partCount; index += 1) {
        parts.push(
          await uploadArchivePart(
            env.FILES,
            plan,
            stages,
            upload.uploadId,
            index,
          ),
        );
      }
      const completed = await upload.complete(parts);
      const boundary = await env.FILES.get(archiveKey, {
        range: { offset: first.byteLength - 1, length: 2 },
      });
      if (boundary === null) throw new Error("Missing completed test archive");

      expect(completed.size).toBe(plan.archiveSize);
      expect(Array.from(new Uint8Array(await boundary.arrayBuffer()))).toEqual([
        0x61, 0x62,
      ]);
    } finally {
      await env.FILES.delete([...stageKeys, archiveKey]);
    }
  }, 15_000);

  it("stages a complete restorable ZIP without buffering the R2 put", async () => {
    const id = crypto.randomUUID();
    const workspaceId = `stage-workspace-${id}`;
    const ownerId = `stage-owner-${id}`;
    const pageId = `stage-page-${id}`;
    const body = "# Staged page\n";
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    const contentHash = await hashMarkdown(body);
    const exportedAt = "2026-08-23T00:00:00.000Z";
    const page = {
      id: pageId,
      parentId: null,
      slug: "staged-page",
      title: "Staged page",
      revision: 1,
      contentHash,
      accessMode: "workspace" as const,
      status: "active" as const,
      trashedAt: null,
      trashBatchId: null,
      createdBy: ownerId,
      createdAt: exportedAt,
      updatedAt: exportedAt,
      bodyBytes,
      file: `pages/${pageId}.md`,
    };
    const version = {
      id: `stage-version-${id}`,
      pageId,
      revision: 1,
      sourceKey: `versions/${workspaceId}/${pageId}/1.md`,
      sourceEtag: "",
      contentHash,
      authorId: ownerId,
      reason: "create" as const,
      createdAt: exportedAt,
      bodyBytes,
      file: `versions/stage-version-${id}.md`,
    };
    const storedVersion = await env.FILES.put(version.sourceKey, body, {
      customMetadata: { content_hash: contentHash },
    });
    version.sourceEtag = storedVersion.etag;
    const manifest = buildPortableManifest(
      {
        exportId: id,
        workspaceId,
        workspaceName: "Stage",
        exportedAt,
        members: [
          {
            id: ownerId,
            email: `${id}@example.com`,
            displayName: "Stage Owner",
            role: "owner",
            status: "active",
            createdAt: exportedAt,
            updatedAt: exportedAt,
          },
        ],
        versions: [version],
        pages: [page],
        assets: [],
        acl: [],
        tags: [],
        pageTags: [],
        links: [],
        aliases: [],
        comments: [],
      },
      new Map(),
      true,
    );
    const zip = planStoredZip([
      { name: page.file, size: bodyBytes },
      { name: version.file, size: bodyBytes },
      {
        name: "manifest.json",
        size: new TextEncoder().encode(manifest).byteLength,
      },
    ]);
    const prefix = `test-exports/${id}/`;
    const planKey = `${prefix}plan.json`;
    const archiveKey = `${prefix}archive.zip`;
    const multipart = planR2MultipartUpload(zip.archiveSize);
    const plan = {
      formatVersion: 1,
      exportId: id,
      workspaceId,
      workspaceName: "Stage",
      exportedAt,
      members: [
        {
          id: ownerId,
          email: `${id}@example.com`,
          displayName: "Stage Owner",
          role: "owner",
          status: "active",
          createdAt: exportedAt,
          updatedAt: exportedAt,
        },
      ],
      versions: [version],
      pages: [page],
      assets: [],
      acl: [],
      tags: [],
      pageTags: [],
      links: [],
      aliases: [],
      comments: [],
      zip,
      groups: [{ start: 0, end: 3 }],
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, 'Stage', ?2)",
      ).bind(workspaceId, exportedAt),
      env.DB.prepare(
        `INSERT INTO users (
           id, workspace_id, email, display_name, role, status,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'Stage Owner', 'owner', 'active', ?4, ?4)`,
      ).bind(ownerId, workspaceId, `${id}@example.com`, exportedAt),
      env.DB.prepare(
        `INSERT INTO pages (
           id, workspace_id, parent_id, slug, title, body_md, revision,
           content_hash, access_mode, status, created_by, created_at, updated_at
         ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1, ?6,
                   'workspace', 'active', ?7, ?8, ?8)`,
      ).bind(
        pageId,
        workspaceId,
        page.slug,
        page.title,
        body,
        contentHash,
        ownerId,
        exportedAt,
      ),
      env.DB.prepare(
        `INSERT INTO page_versions (
           id, page_id, revision, r2_key, content_hash, author_id, reason,
           storage_status, created_at
         ) VALUES (?1, ?2, 1, ?3, ?4, ?5, 'create', 'ready', ?6)`,
      ).bind(
        version.id,
        pageId,
        version.sourceKey,
        contentHash,
        ownerId,
        exportedAt,
      ),
    ]);
    await env.FILES.put(planKey, JSON.stringify(plan));

    try {
      const staged = await stageArchiveSegment(
        env as unknown as McpRuntimeEnv,
        {
          planKey,
          archiveKey,
          archiveSize: zip.archiveSize,
          pageCount: 1,
          stageCount: 1,
          partCount: multipart.parts.length,
          partSize: multipart.partSize,
        },
        0,
        [],
        [],
      );
      const object = await env.FILES.get(staged.key);
      if (object === null) throw new Error("Missing staged test archive");
      const archive = new Uint8Array(await object.arrayBuffer());
      const extracted = unzipSync(archive);

      expect(object.size).toBe(zip.archiveSize);
      expect(new TextDecoder().decode(extracted[page.file])).toBe(body);
      expect(new TextDecoder().decode(extracted[version.file])).toBe(body);
      expect(extracted["manifest.json"]).toBeDefined();
    } finally {
      await env.FILES.delete([
        planKey,
        version.sourceKey,
        `${prefix}staging/00001.bin`,
      ]);
      await env.DB.prepare("DELETE FROM workspaces WHERE id = ?1")
        .bind(workspaceId)
        .run();
    }
  });
});

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of iterable) {
    // Drain the stream so post-body length validation runs.
    void chunk;
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
