import { describe, expect, it } from "vitest";

import {
  buildCentralDirectory,
  buildStoredLocalRecord,
  crc32,
  planStoredZip,
} from "../../src/exports/zip";

const encoder = new TextEncoder();

describe("stored ZIP writer", () => {
  it("creates a standards-shaped archive with data descriptors", () => {
    const data = encoder.encode("hello");
    const plan = planStoredZip([{ name: "pages/hello.md", size: data.byteLength }]);
    const crc = crc32(data);
    const local = buildStoredLocalRecord(entryAt(plan.entries, 0), data);
    const central = buildCentralDirectory(
      plan,
      new Map([["pages/hello.md", crc]]),
    );
    const archive = concatenate([local, central]);
    const view = new DataView(archive.buffer);

    expect(archive.byteLength).toBe(plan.archiveSize);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(plan.centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint32(plan.centralOffset + 16, true)).toBe(crc);
    expect(crc).toBe(0x3610a686);
  });

  it("counts UTF-8 filenames and empty bodies exactly", () => {
    const plan = planStoredZip([
      { name: "pages/日本語.md", size: 0 },
      { name: "manifest.json", size: 2 },
    ]);
    const first = buildStoredLocalRecord(entryAt(plan.entries, 0), new Uint8Array());
    const secondData = encoder.encode("{}");
    const second = buildStoredLocalRecord(entryAt(plan.entries, 1), secondData);
    const central = buildCentralDirectory(
      plan,
      new Map([
        ["pages/日本語.md", crc32(new Uint8Array())],
        ["manifest.json", crc32(secondData)],
      ]),
    );

    expect(first.byteLength + second.byteLength).toBe(plan.centralOffset);
    expect(first.byteLength + second.byteLength + central.byteLength).toBe(
      plan.archiveSize,
    );
  });

  it("rejects a body whose size differs from its plan", () => {
    const plan = planStoredZip([{ name: "page.md", size: 4 }]);
    expect(() =>
      buildStoredLocalRecord(entryAt(plan.entries, 0), encoder.encode("five!")),
    ).toThrow("ZIP entry size changed");
  });

  it("uses ZIP64 at the exact ZIP32 sentinel boundary", () => {
    const firstName = "pad";
    const firstSize = 0xffff_ffff - (30 + firstName.length + 16);
    const plan = planStoredZip([
      { name: firstName, size: firstSize },
      { name: "manifest.json", size: 2 },
    ]);
    const central = buildCentralDirectory(
      plan,
      new Map([
        [firstName, 0],
        ["manifest.json", 0],
      ]),
    );
    const view = new DataView(central.buffer);
    const secondCentralOffset = 46 + firstName.length;

    expect(plan.centralOffset).toBeGreaterThan(0xffff_ffff);
    expect(entryAt(plan.entries, 1).localOffset).toBe(0xffff_ffff);
    expect(view.getUint16(secondCentralOffset + 6, true)).toBe(45);
    expect(view.getUint32(secondCentralOffset + 42, true)).toBe(0xffff_ffff);
    expect(
      view.getUint16(secondCentralOffset + 46 + "manifest.json".length, true),
    ).toBe(0x0001);
    expect(central.byteLength).toBe(plan.centralSize + 76 + 22);
    expect(view.getUint32(plan.centralSize, true)).toBe(0x06064b50);
    expect(view.getUint32(central.byteLength - 22, true)).toBe(0x06054b50);
  });

  it("rejects the ZIP32 size sentinel until per-entry ZIP64 sizes are supported", () => {
    expect(() =>
      planStoredZip([{ name: "unsupported.bin", size: 0xffff_ffff }]),
    ).toThrow("ZIP entry size is not supported");
  });
});

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function entryAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing test entry at index ${String(index)}`);
  }
  return value;
}
