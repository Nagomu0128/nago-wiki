import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  encodeSyncStep1,
  encodeSyncUpdate,
  parseRealtimeMessage,
} from "../src/realtime/protocol";

describe("realtime sync protocol", () => {
  it("answers sync step 1 with the current document state", () => {
    const server = new Y.Doc();
    server.getText("markdown").insert(0, "server state");
    const client = new Y.Doc();

    const reply = parseRealtimeMessage(
      encodeSyncStep1(client),
      server,
      true,
    );
    expect(reply.kind).toBe("reply");
    if (reply.kind !== "reply") {
      throw new Error("Expected a sync reply");
    }

    const clientMessage = parseRealtimeMessage(reply.reply, client, true);
    expect(clientMessage.kind).toBe("update");
    if (clientMessage.kind !== "update") {
      throw new Error("Expected a sync update");
    }
    Y.applyUpdate(client, clientMessage.update);
    expect(client.getText("markdown").toJSON()).toBe("server state");
  });

  it("rejects viewer writes without mutating the server document", () => {
    const client = new Y.Doc();
    client.getText("markdown").insert(0, "not allowed");
    const server = new Y.Doc();

    const result = parseRealtimeMessage(
      encodeSyncUpdate(Y.encodeStateAsUpdate(client)),
      server,
      false,
    );
    expect(result).toEqual({ kind: "read-only" });
    expect(server.getText("markdown").toJSON()).toBe("");
  });

  it("returns a validated editor update for persistence before apply", () => {
    const client = new Y.Doc();
    client.getText("markdown").insert(0, "editor update");
    const server = new Y.Doc();

    const result = parseRealtimeMessage(
      encodeSyncUpdate(Y.encodeStateAsUpdate(client)),
      server,
      true,
    );
    expect(result.kind).toBe("update");
    if (result.kind !== "update") {
      throw new Error("Expected an editor update");
    }

    expect(server.getText("markdown").toJSON()).toBe("");
    Y.applyUpdate(server, result.update);
    expect(server.getText("markdown").toJSON()).toBe("editor update");
  });

  it("does not accept unknown outer message types", () => {
    expect(
      parseRealtimeMessage(new Uint8Array([42]), new Y.Doc(), true),
    ).toEqual({ kind: "unsupported" });
  });
});
