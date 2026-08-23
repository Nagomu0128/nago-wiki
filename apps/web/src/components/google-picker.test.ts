import { afterEach, describe, expect, it, vi } from "vitest";

import { pickGoogleDocument } from "./google-picker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Picker", () => {
  it("selects one Google document with the server-issued configuration", async () => {
    const received: Record<string, unknown> = {};
    let callback: ((response: unknown) => void) | null = null;
    class FakeBuilder {
      setOAuthToken(value: string) { received.accessToken = value; return this; }
      setDeveloperKey(value: string) { received.developerKey = value; return this; }
      setAppId(value: string) { received.appId = value; return this; }
      addView(value: unknown) { received.view = value; return this; }
      setSelectableMimeTypes(value: string) { received.mimeTypes = value; return this; }
      setOrigin(value: string) { received.origin = value; return this; }
      setMaxItems(value: number) { received.maxItems = value; return this; }
      setCallback(value: (response: unknown) => void) { callback = value; return this; }
      build() {
        return {
          setVisible: () => {
            callback?.({
              action: "picked",
              docs: [{ id: "document-1", name: "Product notes" }],
            });
          },
        };
      }
    }
    vi.stubGlobal("window", {
      location: { origin: "https://wiki.example" },
      google: {
        picker: {
          PickerBuilder: FakeBuilder,
          ViewId: { DOCS: "docs" },
          Action: { PICKED: "picked", CANCEL: "cancel" },
        },
      },
    });

    await expect(pickGoogleDocument({
      accessToken: "access-token",
      developerKey: "developer-key",
      appId: "1234567890",
    })).resolves.toEqual({ documentId: "document-1", name: "Product notes" });
    expect(received).toMatchObject({
      accessToken: "access-token",
      developerKey: "developer-key",
      appId: "1234567890",
      mimeTypes: "application/vnd.google-apps.document",
      origin: "https://wiki.example",
      maxItems: 1,
    });
  });
});
