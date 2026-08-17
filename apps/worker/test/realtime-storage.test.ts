import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  computeFlushDeadline,
  computeRetryAt,
  createCompactionSnapshot,
  realtimeUpdateMetaBindings,
  restoreYDoc,
} from "../src/realtime/storage";
import { validateRealtimeUpdate } from "../src/realtime/page-room";

describe("realtime persistence policy", () => {
  it("flushes after two quiet seconds or fifteen dirty seconds", () => {
    expect(computeFlushDeadline(1_000, 2_000)).toBe(4_000);
    expect(computeFlushDeadline(1_000, 15_900)).toBe(16_000);
  });

  it("uses capped exponential alarm retry", () => {
    expect(computeRetryAt(10_000, 0)).toBe(11_000);
    expect(computeRetryAt(10_000, 1)).toBe(12_000);
    expect(computeRetryAt(10_000, 8)).toBe(70_000);
  });

  it("binds flush metadata in SQL column order", () => {
    expect(realtimeUpdateMetaBindings(1_000, 2_000, 4_000, "user-1", "edit"))
      .toEqual([1_000, 2_000, 4_000, 2_000, "user-1", "edit"]);
  });

  it("compacts applied updates while preserving later updates", () => {
    const source = new Y.Doc();
    source.getText("markdown").insert(0, "base");
    const baseSnapshot = Y.encodeStateAsUpdate(source);
    const afterBase = Y.encodeStateVector(source);

    source.getText("markdown").insert(4, " update");
    const storedUpdate = Y.encodeStateAsUpdate(source, afterBase);
    const compacted = createCompactionSnapshot(baseSnapshot, [storedUpdate]);
    const afterCompaction = Y.encodeStateVector(source);

    source.getText("markdown").insert(11, " pending");
    const pendingUpdate = Y.encodeStateAsUpdate(source, afterCompaction);
    const restored = restoreYDoc(compacted, [pendingUpdate]);

    expect(restored.getText("markdown").toJSON()).toBe(
      "base update pending",
    );
  });

  it("rejects a Yjs update whose resulting Markdown exceeds one MiB", () => {
    const current = new Y.Doc();
    current.getText("markdown").insert(0, "base");
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(current));
    const stateVector = Y.encodeStateVector(current);
    next.getText("markdown").insert(4, "x".repeat(1_048_576));
    const update = Y.encodeStateAsUpdate(next, stateVector);

    expect(() => { validateRealtimeUpdate(current, update); }).toThrow(
      "Markdown exceeds the 1 MiB page limit",
    );
    expect(current.getText("markdown").toJSON()).toBe("base");
  });

  it("accepts a bounded Markdown update without mutating the source document", () => {
    const current = new Y.Doc();
    current.getText("markdown").insert(0, "base");
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(current));
    const stateVector = Y.encodeStateVector(current);
    next.getText("markdown").insert(4, " update");

    expect(() => {
      validateRealtimeUpdate(
        current,
        Y.encodeStateAsUpdate(next, stateVector),
      );
    }).not.toThrow();
    expect(current.getText("markdown").toJSON()).toBe("base");
  });
});
