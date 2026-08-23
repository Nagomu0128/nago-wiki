import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPortablePath,
  parsePortableManifest,
} from "../apps/worker/src/exports/manifest.ts";
import { Crc32 } from "../apps/worker/src/exports/zip.ts";

const MAX_VALIDATION_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_VALIDATION_ENTRY_BYTES = 0xffff_ffff;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

export interface PortableArchiveValidation {
  archiveSha256: string;
  exportId: string;
  workspaceId: string;
  exportedAt: string;
  counts: {
    members: number;
    pages: number;
    versions: number;
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
  const { archiveSha256, files } = await digestStoredArchive(path);
  const manifestBytes = requiredFile(files, "manifest.json").body;
  if (manifestBytes === undefined)
    throw new Error("Portable export manifest was not retained");
  const manifestJson: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
  );
  const manifest = parsePortableManifest(manifestJson);
  const expectedFiles = new Set(["manifest.json"]);
  for (const record of [
    ...manifest.pages,
    ...manifest.versions,
    ...manifest.assets,
  ]) {
    const body = requiredFile(files, record.file);
    expectedFiles.add(record.file);
    if (body.size !== record.size) {
      throw new Error(`Size mismatch for ${record.file}`);
    }
    if (body.sha256 !== record.sha256) {
      throw new Error(`SHA-256 mismatch for ${record.file}`);
    }
  }
  const unexpected = [...files.keys()].filter(
    (name) => !expectedFiles.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected archive entries: ${unexpected.join(", ")}`);
  }
  return {
    archiveSha256,
    exportId: manifest.exportId,
    workspaceId: manifest.workspaceId,
    exportedAt: manifest.exportedAt,
    counts: manifest.counts,
  };
}

interface DigestedArchiveEntry {
  size: number;
  sha256: string;
  body?: Uint8Array;
}

async function digestStoredArchive(path: string): Promise<{
  archiveSha256: string;
  files: Map<string, DigestedArchiveEntry>;
}> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (before.size > MAX_VALIDATION_ARCHIVE_BYTES) {
      throw new Error(
        "Portable export exceeds the 64 GiB local validation limit",
      );
    }
    const central = await readCentralDirectory(handle, before.size);
    const files = new Map<string, DigestedArchiveEntry>();
    let totalBytes = 0;
    for (const [index, entry] of central.entries.entries()) {
      totalBytes += entry.size;
      if (totalBytes > MAX_VALIDATION_ARCHIVE_BYTES) {
        throw new Error("Portable export expands beyond validation limits");
      }
      const nextOffset =
        central.entries[index + 1]?.localOffset ?? central.offset;
      const dataOffset = await validateLocalRecord(handle, entry, nextOffset);
      files.set(entry.name, await digestEntry(handle, entry, dataOffset));
    }
    const archiveSha256 = await hashFile(handle, before.size);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new Error("Portable export changed during validation");
    }
    return { archiveSha256, files };
  } finally {
    await handle.close();
  }
}

interface CentralEntry {
  name: string;
  flags: number;
  crc32: number;
  size: number;
  localOffset: number;
}

async function readCentralDirectory(
  handle: FileHandle,
  archiveSize: number,
): Promise<{ entries: CentralEntry[]; offset: number }> {
  const tailLength = Math.min(archiveSize, 65_557);
  const tailOffset = archiveSize - tailLength;
  const tail = await readExact(handle, tailOffset, tailLength);
  let eocdIndex = -1;
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (
      tail.readUInt32LE(index) === EOCD_SIGNATURE &&
      index + 22 + tail.readUInt16LE(index + 20) === tail.byteLength
    ) {
      eocdIndex = index;
      break;
    }
  }
  if (eocdIndex < 0) throw new Error("ZIP end record is missing");
  if (tail.readUInt16LE(eocdIndex + 20) !== 0) {
    throw new Error("ZIP comments are not portable");
  }
  const eocdOffset = tailOffset + eocdIndex;
  if (
    tail.readUInt16LE(eocdIndex + 4) !== 0 ||
    tail.readUInt16LE(eocdIndex + 6) !== 0
  ) {
    throw new Error("Multi-disk ZIP archives are not portable");
  }
  let entryCount = tail.readUInt16LE(eocdIndex + 10);
  const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
  let centralSize = tail.readUInt32LE(eocdIndex + 12);
  let centralOffset = tail.readUInt32LE(eocdIndex + 16);
  const eocdEntryCount = entryCount;
  const eocdCentralSize = centralSize;
  const eocdCentralOffset = centralOffset;
  let trailerOffset = eocdOffset;
  if (
    entryCount === 0xffff ||
    centralSize === 0xffff_ffff ||
    centralOffset === 0xffff_ffff
  ) {
    const locator = await readExact(handle, eocdOffset - 20, 20);
    if (
      locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE ||
      locator.readUInt32LE(4) !== 0 ||
      locator.readUInt32LE(16) !== 1
    ) {
      throw new Error("ZIP64 locator is missing");
    }
    const zip64Offset = safeZipNumber(locator.readBigUInt64LE(8));
    const zip64 = await readExact(handle, zip64Offset, 56);
    if (
      zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE ||
      zip64.readBigUInt64LE(4) !== 44n ||
      zip64.readUInt32LE(16) !== 0 ||
      zip64.readUInt32LE(20) !== 0 ||
      zip64.readUInt16LE(12) !== 45 ||
      zip64.readUInt16LE(14) !== 45 ||
      zip64.readBigUInt64LE(24) !== zip64.readBigUInt64LE(32) ||
      zip64Offset + 56 !== eocdOffset - 20
    ) {
      throw new Error("ZIP64 end record is missing");
    }
    entryCount = safeZipNumber(zip64.readBigUInt64LE(32));
    centralSize = safeZipNumber(zip64.readBigUInt64LE(40));
    centralOffset = safeZipNumber(zip64.readBigUInt64LE(48));
    trailerOffset = zip64Offset;
    if (
      (eocdEntryCount !== 0xffff && eocdEntryCount !== entryCount) ||
      (eocdCentralSize !== 0xffff_ffff && eocdCentralSize !== centralSize) ||
      (eocdCentralOffset !== 0xffff_ffff && eocdCentralOffset !== centralOffset)
    ) {
      throw new Error("ZIP64 and ZIP32 end records disagree");
    }
  }
  if (entriesOnDisk !== 0xffff && entriesOnDisk !== entryCount) {
    throw new Error("ZIP entry counts are inconsistent");
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Portable export contains too many archive entries");
  }
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error("Portable export central directory is too large");
  }
  if (centralOffset + centralSize !== trailerOffset) {
    throw new Error("ZIP central directory boundaries are inconsistent");
  }
  const bytes = await readExact(handle, centralOffset, centralSize);
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  const normalizedNames = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    if (
      cursor + 46 > bytes.byteLength ||
      bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("ZIP central directory entry is invalid");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    let compressedSize = bytes.readUInt32LE(cursor + 20);
    let size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskNumber = bytes.readUInt16LE(cursor + 34);
    const localOffset32 = bytes.readUInt32LE(cursor + 42);
    let localOffset = localOffset32;
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength)
      throw new Error("ZIP central directory is truncated");
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const extra = bytes.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength,
    );
    ({ compressedSize, size, localOffset } = readZip64Values(
      extra,
      compressedSize,
      size,
      localOffset,
    ));
    if (
      flags !== 0x0808 ||
      method !== 0 ||
      compressedSize !== size ||
      commentLength !== 0 ||
      diskNumber !== 0 ||
      bytes.readUInt16LE(cursor + 4) !==
        (localOffset32 === 0xffff_ffff ? 45 : 20) ||
      bytes.readUInt16LE(cursor + 6) !==
        (localOffset32 === 0xffff_ffff ? 45 : 20) ||
      bytes.readUInt16LE(cursor + 12) !== 0 ||
      bytes.readUInt16LE(cursor + 14) !== 0 ||
      bytes.readUInt16LE(cursor + 36) !== 0 ||
      bytes.readUInt32LE(cursor + 38) !== 0
    ) {
      throw new Error(
        `Archive entry must use unencrypted stored data: ${name}`,
      );
    }
    if (size >= MAX_VALIDATION_ENTRY_BYTES) {
      throw new Error(`Archive entry exceeds 4 GiB: ${name}`);
    }
    if (!isPortablePath(name))
      throw new Error(`Unsafe archive entry path: ${name}`);
    const normalizedName = name.normalize("NFKC").toLowerCase();
    if (names.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`Portable archive paths collide: ${name}`);
    }
    names.add(name);
    normalizedNames.add(normalizedName);
    entries.push({ name, flags, crc32, size, localOffset });
    cursor = end;
  }
  if (entries.length !== entryCount) {
    throw new Error("ZIP entry count does not match its central directory");
  }
  if (entries[0]?.localOffset !== 0) {
    throw new Error("ZIP local records must begin at offset zero");
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (
      (entries[index - 1]?.localOffset ?? 0) >=
      (entries[index]?.localOffset ?? 0)
    ) {
      throw new Error("ZIP central directory order differs from local records");
    }
  }
  return { entries, offset: centralOffset };
}

function readZip64Values(
  extra: Buffer,
  compressed32: number,
  size32: number,
  offset32: number,
): { compressedSize: number; size: number; localOffset: number } {
  if (compressed32 === 0xffff_ffff || size32 === 0xffff_ffff) {
    throw new Error("Per-entry ZIP64 sizes are not portable");
  }
  if (offset32 === 0xffff_ffff) {
    if (
      extra.byteLength !== 12 ||
      extra.readUInt16LE(0) !== 0x0001 ||
      extra.readUInt16LE(2) !== 8
    ) {
      throw new Error("ZIP64 offset extra field is invalid");
    }
    return {
      compressedSize: compressed32,
      size: size32,
      localOffset: safeZipNumber(extra.readBigUInt64LE(4)),
    };
  }
  if (extra.byteLength !== 0) {
    throw new Error("Unexpected ZIP central directory extra field");
  }
  return { compressedSize: compressed32, size: size32, localOffset: offset32 };
}

async function validateLocalRecord(
  handle: FileHandle,
  entry: CentralEntry,
  nextOffset: number,
): Promise<number> {
  const header = await readExact(handle, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`Local ZIP header is missing for ${entry.name}`);
  }
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (
    flags !== entry.flags ||
    flags !== 0x0808 ||
    method !== 0 ||
    header.readUInt16LE(4) !== 20 ||
    header.readUInt16LE(10) !== 0 ||
    header.readUInt16LE(12) !== 0 ||
    header.readUInt32LE(14) !== 0 ||
    header.readUInt32LE(18) !== 0 ||
    header.readUInt32LE(22) !== 0 ||
    extraLength !== 0
  ) {
    throw new Error(
      `Local ZIP header differs from central entry: ${entry.name}`,
    );
  }
  const name = new TextDecoder("utf-8", { fatal: true }).decode(
    await readExact(handle, entry.localOffset + 30, nameLength),
  );
  if (name !== entry.name) {
    throw new Error(`Local ZIP name differs from central entry: ${entry.name}`);
  }
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const descriptorLength = 16;
  if (dataOffset + entry.size + descriptorLength !== nextOffset) {
    throw new Error(
      `ZIP local record boundaries are inconsistent: ${entry.name}`,
    );
  }
  const descriptor = await readExact(handle, dataOffset + entry.size, 16);
  if (
    descriptor.readUInt32LE(0) !== DATA_DESCRIPTOR_SIGNATURE ||
    descriptor.readUInt32LE(4) !== entry.crc32 ||
    descriptor.readUInt32LE(8) !== entry.size ||
    descriptor.readUInt32LE(12) !== entry.size
  ) {
    throw new Error(
      `ZIP data descriptor differs from central entry: ${entry.name}`,
    );
  }
  return dataOffset;
}

async function digestEntry(
  handle: FileHandle,
  entry: CentralEntry,
  dataOffset: number,
): Promise<DigestedArchiveEntry> {
  if (entry.name === "manifest.json" && entry.size > MAX_MANIFEST_BYTES) {
    throw new Error("Portable export manifest exceeds 32 MiB");
  }
  const hash = createHash("sha256");
  const crc = new Crc32();
  const chunks: Uint8Array[] = [];
  if (entry.size > 0) {
    for await (const value of handle.createReadStream({
      start: dataOffset,
      end: dataOffset + entry.size - 1,
      autoClose: false,
    })) {
      const chunk = value as Uint8Array;
      hash.update(chunk);
      crc.update(chunk);
      if (entry.name === "manifest.json") chunks.push(chunk.slice());
    }
  }
  if (crc.digest() !== entry.crc32) {
    throw new Error(`CRC-32 mismatch for ${entry.name}`);
  }
  return {
    size: entry.size,
    sha256: hash.digest("hex"),
    ...(entry.name === "manifest.json"
      ? { body: concatenate(chunks, entry.size) }
      : {}),
  };
}

async function hashFile(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  if (size > 0) {
    for await (const value of handle.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
    })) {
      const chunk = value as Uint8Array;
      hash.update(chunk);
    }
  }
  return hash.digest("hex");
}

async function readExact(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (position < 0 || length < 0) throw new Error("ZIP range is invalid");
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error("ZIP archive is truncated");
    offset += bytesRead;
  }
  return buffer;
}

function safeZipNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("ZIP offset exceeds safe range");
  return result;
}

function requiredFile(
  files: ReadonlyMap<string, DigestedArchiveEntry>,
  name: string,
): DigestedArchiveEntry {
  const value = files.get(name);
  if (value === undefined) throw new Error(`Missing archive entry: ${name}`);
  return value;
}

function concatenate(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
