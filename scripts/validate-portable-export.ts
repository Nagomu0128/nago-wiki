import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, type Unzipped } from "fflate";

import { parsePortableManifest } from "../apps/worker/src/exports/manifest.ts";

const MAX_VALIDATION_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export interface PortableArchiveValidation {
  archiveSha256: string;
  exportId: string;
  workspaceId: string;
  exportedAt: string;
  counts: {
    pages: number;
    assets: number;
    acl: number;
    tags: number;
    pageTags: number;
    links: number;
    aliases: number;
    comments: number;
  };
}

export async function validatePortableArchive(
  path: string,
): Promise<PortableArchiveValidation> {
  const archiveInfo = await stat(path);
  if (archiveInfo.size > MAX_VALIDATION_ARCHIVE_BYTES) {
    throw new Error(
      "The local validator supports archives up to 2 GiB; use the streaming staging restore for larger exports",
    );
  }
  const archive = await readFile(path);
  const files = unzipSync(archive);
  const manifestBytes = requiredFile(files, "manifest.json");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("Portable export manifest exceeds 32 MiB");
  }
  const manifestJson: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
  );
  const manifest = parsePortableManifest(manifestJson);
  const expectedFiles = new Set(["manifest.json"]);
  for (const record of [...manifest.pages, ...manifest.assets]) {
    const body = requiredFile(files, record.file);
    expectedFiles.add(record.file);
    if (body.byteLength !== record.size) {
      throw new Error(`Size mismatch for ${record.file}`);
    }
    if (sha256(body) !== record.sha256) {
      throw new Error(`SHA-256 mismatch for ${record.file}`);
    }
  }
  const unexpected = Object.keys(files).filter(
    (name) => !expectedFiles.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected archive entries: ${unexpected.join(", ")}`);
  }
  return {
    archiveSha256: sha256(archive),
    exportId: manifest.exportId,
    workspaceId: manifest.workspaceId,
    exportedAt: manifest.exportedAt,
    counts: manifest.counts,
  };
}

function requiredFile(files: Unzipped, name: string): Uint8Array {
  const value = files[name];
  if (value === undefined) throw new Error(`Missing archive entry: ${name}`);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write(
      "Usage: npm run validate:portable-export -- <wiki-export.zip>\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await validatePortableArchive(resolve(path));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Validation failed"}\n`,
      );
      process.exitCode = 1;
    }
  }
}
