import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const MESSAGE_SYNC = 0;

export type ParsedRealtimeMessage =
  | { kind: "reply"; reply: Uint8Array }
  | { kind: "update"; update: Uint8Array; broadcast: Uint8Array }
  | { kind: "read-only" }
  | { kind: "unsupported" };

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function parseRealtimeMessage(
  frame: ArrayBuffer | Uint8Array,
  doc: Y.Doc,
  canWrite: boolean,
): ParsedRealtimeMessage {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const decoder = decoding.createDecoder(bytes);

  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
    return { kind: "unsupported" };
  }

  const messageType = decoding.readVarUint(decoder);
  if (messageType === syncProtocol.messageYjsSyncStep1) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncStep1(decoder, encoder, doc);
    return { kind: "reply", reply: encoding.toUint8Array(encoder) };
  }

  if (
    messageType === syncProtocol.messageYjsSyncStep2 ||
    messageType === syncProtocol.messageYjsUpdate
  ) {
    if (!canWrite) {
      return { kind: "read-only" };
    }

    const update = decoding.readVarUint8Array(decoder);
    // Decode before persistence so malformed data cannot poison the update log.
    Y.decodeUpdate(update);
    return {
      kind: "update",
      update,
      broadcast: encodeSyncUpdate(update),
    };
  }

  return { kind: "unsupported" };
}
