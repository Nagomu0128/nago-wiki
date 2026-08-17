const encoder = new TextEncoder();

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const UTF8_WITH_DATA_DESCRIPTOR = 0x0808;
const ZIP32_MAX = 0xffff_ffffn;

export interface ZipEntryPlan {
  name: string;
  size: number;
  localOffset: number;
}

export interface ZipArchivePlan {
  entries: ZipEntryPlan[];
  centralOffset: number;
  centralSize: number;
  archiveSize: number;
}

export function planStoredZip(
  files: readonly { name: string; size: number }[],
): ZipArchivePlan {
  let localOffset = 0n;
  const entries = files.map((file) => {
    validateEntry(file);
    const result = {
      name: file.name,
      size: file.size,
      localOffset: safeNumber(localOffset),
    };
    localOffset += BigInt(localRecordLength(file.name, file.size));
    return result;
  });
  const centralOffset = localOffset;
  let centralSize = 0n;
  for (const entry of entries) {
    centralSize += BigInt(centralRecordLength(entry));
  }
  const needsZip64 = centralOffset > ZIP32_MAX || centralSize > ZIP32_MAX;
  const trailerSize = BigInt(22 + (needsZip64 ? 76 : 0));
  return {
    entries,
    centralOffset: safeNumber(centralOffset),
    centralSize: safeNumber(centralSize),
    archiveSize: safeNumber(centralOffset + centralSize + trailerSize),
  };
}

export function buildStoredLocalRecord(
  entry: ZipEntryPlan,
  data: Uint8Array,
): Uint8Array {
  if (data.byteLength !== entry.size) {
    throw new Error(`ZIP entry size changed for ${entry.name}`);
  }
  const name = encoder.encode(entry.name);
  const output = new Uint8Array(30 + name.byteLength + data.byteLength + 16);
  const view = new DataView(output.buffer);
  writeUint32(view, 0, LOCAL_FILE_HEADER_SIGNATURE);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, UTF8_WITH_DATA_DESCRIPTOR);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint32(view, 14, 0);
  writeUint32(view, 18, 0);
  writeUint32(view, 22, 0);
  writeUint16(view, 26, name.byteLength);
  writeUint16(view, 28, 0);
  output.set(name, 30);
  output.set(data, 30 + name.byteLength);
  const descriptorOffset = 30 + name.byteLength + data.byteLength;
  writeUint32(view, descriptorOffset, DATA_DESCRIPTOR_SIGNATURE);
  writeUint32(view, descriptorOffset + 4, crc32(data));
  writeUint32(view, descriptorOffset + 8, data.byteLength);
  writeUint32(view, descriptorOffset + 12, data.byteLength);
  return output;
}

export function buildCentralDirectory(
  plan: ZipArchivePlan,
  crcByName: ReadonlyMap<string, number>,
): Uint8Array {
  const output = new Uint8Array(plan.centralSize + endRecordLength(plan));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const entry of plan.entries) {
    const crc = crcByName.get(entry.name);
    if (crc === undefined) throw new Error(`Missing CRC for ZIP entry ${entry.name}`);
    const name = encoder.encode(entry.name);
    const needsZip64Offset = BigInt(entry.localOffset) > ZIP32_MAX;
    const extra = needsZip64Offset ? zip64OffsetExtra(entry.localOffset) : new Uint8Array();
    writeUint32(view, offset, CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(view, offset + 4, needsZip64Offset ? 45 : 20);
    writeUint16(view, offset + 6, 20);
    writeUint16(view, offset + 8, UTF8_WITH_DATA_DESCRIPTOR);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0);
    writeUint16(view, offset + 14, 0);
    writeUint32(view, offset + 16, crc);
    writeUint32(view, offset + 20, entry.size);
    writeUint32(view, offset + 24, entry.size);
    writeUint16(view, offset + 28, name.byteLength);
    writeUint16(view, offset + 30, extra.byteLength);
    writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0);
    writeUint16(view, offset + 36, 0);
    writeUint32(view, offset + 38, 0);
    writeUint32(
      view,
      offset + 42,
      needsZip64Offset ? Number(ZIP32_MAX) : entry.localOffset,
    );
    output.set(name, offset + 46);
    output.set(extra, offset + 46 + name.byteLength);
    offset += 46 + name.byteLength + extra.byteLength;
  }
  writeEndRecords(output, offset, plan);
  return output;
}

export function crc32(value: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of value) {
    crc = tableValue((crc ^ byte) & 0xff) ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function tableValue(index: number): number {
  const value = CRC32_TABLE[index];
  if (value === undefined) throw new Error("CRC32 table lookup failed");
  return value;
}

export function localRecordLength(name: string, size: number): number {
  return 30 + encoder.encode(name).byteLength + size + 16;
}

function centralRecordLength(entry: ZipEntryPlan): number {
  return (
    46 +
    encoder.encode(entry.name).byteLength +
    (BigInt(entry.localOffset) > ZIP32_MAX ? 12 : 0)
  );
}

function endRecordLength(plan: ZipArchivePlan): number {
  return 22 + (needsZip64End(plan) ? 76 : 0);
}

function writeEndRecords(
  output: Uint8Array,
  startOffset: number,
  plan: ZipArchivePlan,
): void {
  const view = new DataView(output.buffer);
  const needsZip64 = needsZip64End(plan);
  let offset = startOffset;
  if (needsZip64) {
    const zip64EndOffset = BigInt(plan.centralOffset + plan.centralSize);
    writeUint32(view, offset, ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
    writeUint64(view, offset + 4, 44n);
    writeUint16(view, offset + 12, 45);
    writeUint16(view, offset + 14, 45);
    writeUint32(view, offset + 16, 0);
    writeUint32(view, offset + 20, 0);
    writeUint64(view, offset + 24, BigInt(plan.entries.length));
    writeUint64(view, offset + 32, BigInt(plan.entries.length));
    writeUint64(view, offset + 40, BigInt(plan.centralSize));
    writeUint64(view, offset + 48, BigInt(plan.centralOffset));
    offset += 56;
    writeUint32(view, offset, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE);
    writeUint32(view, offset + 4, 0);
    writeUint64(view, offset + 8, zip64EndOffset);
    writeUint32(view, offset + 16, 1);
    offset += 20;
  }
  writeUint32(view, offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(view, offset + 4, 0);
  writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, Math.min(plan.entries.length, 0xffff));
  writeUint16(view, offset + 10, Math.min(plan.entries.length, 0xffff));
  writeUint32(view, offset + 12, Math.min(plan.centralSize, Number(ZIP32_MAX)));
  writeUint32(view, offset + 16, Math.min(plan.centralOffset, Number(ZIP32_MAX)));
  writeUint16(view, offset + 20, 0);
}

function zip64OffsetExtra(localOffset: number): Uint8Array {
  const result = new Uint8Array(12);
  const view = new DataView(result.buffer);
  writeUint16(view, 0, 0x0001);
  writeUint16(view, 2, 8);
  writeUint64(view, 4, BigInt(localOffset));
  return result;
}

function needsZip64End(plan: ZipArchivePlan): boolean {
  return (
    BigInt(plan.centralOffset) > ZIP32_MAX ||
    BigInt(plan.centralSize) > ZIP32_MAX ||
    plan.entries.length > 0xffff
  );
}

function validateEntry(file: { name: string; size: number }): void {
  const nameLength = encoder.encode(file.name).byteLength;
  if (nameLength === 0 || nameLength > 0xffff) {
    throw new Error("ZIP entry name must contain 1 to 65535 UTF-8 bytes");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > Number(ZIP32_MAX)) {
    throw new Error(`ZIP entry size is not supported for ${file.name}`);
  }
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("ZIP archive exceeds safe size");
  return result;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeUint64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

const CRC32_TABLE = (() => {
  const result = new Uint32Array(256);
  for (let index = 0; index < result.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    result[index] = value >>> 0;
  }
  return result;
})();
