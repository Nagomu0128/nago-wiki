import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { zipSync } from "fflate";

import { buildPortableManifest } from "../apps/worker/src/exports/manifest.ts";
import { validatePortableArchive } from "./validate-portable-export.ts";

void test("validates a restorable portable export archive", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nago-export-validator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const page = new TextEncoder().encode("# Home\n");
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
    zipSync({
      "pages/home.md": [page, { level: 0 }],
      "manifest.json": [new TextEncoder().encode(manifest), { level: 0 }],
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
    zipSync({
      "pages/home.md": [actual, { level: 0 }],
      "manifest.json": [new TextEncoder().encode(manifest), { level: 0 }],
    }),
  );

  await assert.rejects(validatePortableArchive(path), /SHA-256 mismatch/u);
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
