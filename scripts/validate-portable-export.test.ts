import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPortableManifest } from "../apps/worker/src/exports/manifest.ts";
import {
  buildCentralDirectory,
  buildStoredLocalRecord,
  crc32,
  planStoredZip,
} from "../apps/worker/src/exports/zip.ts";
import { validatePortableArchive } from "./validate-portable-export.ts";

void test("validates a restorable portable export archive", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nago-export-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const page = concatenate([
    new TextEncoder().encode("# Home\n"),
    new Uint8Array([0x50, 0x4b, 0x07, 0x08]),
  ]);
  const pageHash = sha256Hex(page);
  const manifest = buildPortableManifest(
    {
      exportId: "export-test",
      workspaceId: "workspace-test",
      workspaceName: "Test Workspace",
      exportedAt: "2026-08-23T00:00:00.000Z",
      members: [testOwner("2026-08-23T00:00:00.000Z")],
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
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:00.000Z",
          bodyBytes: page.byteLength,
          file: "pages/home.md",
        },
      ],
      versions: [testVersion(pageHash, page.byteLength)],
      assets: [],
      acl: [],
      tags: [],
      pageTags: [],
      links: [],
      aliases: [],
      comments: [],
    },
    new Map(),
  );
  const path = join(directory, "wiki-export.zip");
  await writeFile(
    path,
    storedZip({
      "pages/home.md": page,
      "versions/home-version-1.md": page,
      "manifest.json": new TextEncoder().encode(manifest),
    }),
  );

  const result = await validatePortableArchive(path);

  assert.equal(result.exportId, "export-test");
  assert.equal(result.counts.pages, 1);
  assert.match(result.archiveSha256, /^[a-f\d]{64}$/u);
});

void test("rejects a page whose SHA-256 does not match", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nago-export-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const expected = new TextEncoder().encode("expected");
  const actual = new TextEncoder().encode("tampered");
  const manifest = buildPortableManifest(
    {
      exportId: "export-tampered",
      workspaceId: "workspace-test",
      workspaceName: "Test Workspace",
      exportedAt: "2026-08-23T00:00:00.000Z",
      members: [testOwner("2026-08-23T00:00:00.000Z")],
      pages: [
        {
          id: "home",
          parentId: null,
          slug: "home",
          title: "Home",
          revision: 1,
          contentHash: sha256Hex(expected),
          accessMode: "workspace",
          status: "active",
          trashedAt: null,
          trashBatchId: null,
          createdBy: "owner",
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:00.000Z",
          bodyBytes: actual.byteLength,
          file: "pages/home.md",
        },
      ],
      versions: [testVersion(sha256Hex(expected), actual.byteLength)],
      assets: [],
      acl: [],
      tags: [],
      pageTags: [],
      links: [],
      aliases: [],
      comments: [],
    },
    new Map(),
  );
  const path = join(directory, "tampered.zip");
  await writeFile(
    path,
    storedZip({
      "pages/home.md": actual,
      "versions/home-version-1.md": actual,
      "manifest.json": new TextEncoder().encode(manifest),
    }),
  );

  await assert.rejects(validatePortableArchive(path), /SHA-256 mismatch/u);
});

void test("rejects a local header name that disagrees with the central directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nago-export-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const page = new TextEncoder().encode("# Home\n");
  const manifest = buildPortableManifest(
    {
      exportId: "export-smuggled",
      workspaceId: "workspace-test",
      workspaceName: "Test Workspace",
      exportedAt: "2026-08-23T00:00:00.000Z",
      members: [testOwner("2026-08-23T00:00:00.000Z")],
      pages: [testPage(sha256Hex(page), page.byteLength)],
      versions: [testVersion(sha256Hex(page), page.byteLength)],
      assets: [],
      acl: [],
      tags: [],
      pageTags: [],
      links: [],
      aliases: [],
      comments: [],
    },
    new Map(),
  );
  const archive = storedZip({
    "pages/home.md": page,
    "versions/home-version-1.md": page,
    "manifest.json": new TextEncoder().encode(manifest),
  });
  // Keep the byte length and central directory untouched while changing the
  // first local filename from pages/home.md to pages/evil.md.
  archive.set(new TextEncoder().encode("pages/evil.md"), 30);
  const path = join(directory, "smuggled.zip");
  await writeFile(path, archive);

  await assert.rejects(
    validatePortableArchive(path),
    /Local ZIP name differs from central entry/u,
  );
});

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function testOwner(timestamp: string) {
  return {
    id: "owner",
    email: "owner@example.com",
    displayName: "Owner",
    role: "owner" as const,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function testVersion(contentHash: string, bodyBytes: number) {
  return {
    id: "home-version-1",
    pageId: "home",
    revision: 1,
    sourceKey: "versions/workspace-test/home/1.md",
    sourceEtag: "version-etag",
    contentHash,
    authorId: "owner",
    reason: "create" as const,
    createdAt: "2026-08-23T00:00:00.000Z",
    bodyBytes,
    file: "versions/home-version-1.md",
  };
}

function testPage(contentHash: string, bodyBytes: number) {
  return {
    id: "home",
    parentId: null,
    slug: "home",
    title: "Home",
    revision: 1,
    contentHash,
    accessMode: "workspace" as const,
    status: "active" as const,
    trashedAt: null,
    trashBatchId: null,
    createdBy: "owner",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    bodyBytes,
    file: "pages/home.md",
  };
}

function storedZip(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const values = Object.entries(files).map(([name, data]) => ({ name, data }));
  const plan = planStoredZip(
    values.map(({ name, data }) => ({ name, size: data.byteLength })),
  );
  return concatenate([
    ...values.map(({ data }, index) => {
      const entry = plan.entries[index];
      if (entry === undefined) throw new Error("Missing ZIP plan entry");
      return buildStoredLocalRecord(entry, data);
    }),
    buildCentralDirectory(
      plan,
      new Map(values.map(({ name, data }) => [name, crc32(data)])),
    ),
  ]);
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
