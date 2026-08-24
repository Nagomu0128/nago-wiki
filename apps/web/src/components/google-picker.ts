import type { GooglePickerConfiguration } from "../api";

export interface PickedGoogleDocument {
  documentId: string;
  name: string;
}

interface PickerResponse {
  action?: unknown;
  docs?: unknown;
}

interface PickerInstance {
  setVisible(visible: boolean): void;
}

interface PickerBuilder {
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  addView(view: unknown): PickerBuilder;
  setSelectableMimeTypes(mimeTypes: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setMaxItems(max: number): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  build(): PickerInstance;
}

interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown };
  Action: { PICKED: unknown; CANCEL: unknown };
}

interface GoogleApiLoader {
  load(
    api: string,
    options: {
      callback: () => void;
      onerror: () => void;
      timeout: number;
      ontimeout: () => void;
    },
  ): void;
}

declare global {
  interface Window {
    gapi?: GoogleApiLoader;
    google?: { picker?: PickerNamespace };
  }
}

let pickerApiPromise: Promise<PickerNamespace> | null = null;

export async function pickGoogleDocument(
  configuration: GooglePickerConfiguration,
): Promise<PickedGoogleDocument | null> {
  const picker = await loadPickerApi();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: PickedGoogleDocument | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      new picker.PickerBuilder()
        .setOAuthToken(configuration.accessToken)
        .setDeveloperKey(configuration.developerKey)
        .setAppId(configuration.appId)
        .addView(picker.ViewId.DOCS)
        .setSelectableMimeTypes("application/vnd.google-apps.document")
        .setOrigin(window.location.origin)
        .setMaxItems(1)
        .setCallback((response) => {
          if (response.action === picker.Action.CANCEL) {
            settle(null);
            return;
          }
          if (response.action !== picker.Action.PICKED) {
            return;
          }
          if (!Array.isArray(response.docs)) {
            fail(new Error("Google Picker returned an invalid document list"));
            return;
          }
          const document: unknown = response.docs[0];
          if (
            typeof document !== "object" ||
            document === null ||
            !("id" in document) ||
            typeof document.id !== "string"
          ) {
            fail(new Error("Google Picker returned an invalid document"));
            return;
          }
          settle({
            documentId: document.id,
            name:
              "name" in document && typeof document.name === "string"
                ? document.name
                : document.id,
          });
        })
        .build()
        .setVisible(true);
    } catch (error) {
      fail(error);
    }
  });
}

function loadPickerApi(): Promise<PickerNamespace> {
  const loaded = window.google?.picker;
  if (loaded !== undefined) return Promise.resolve(loaded);
  if (pickerApiPromise !== null) return pickerApiPromise;
  const loading = new Promise<PickerNamespace>((resolve, reject) => {
    const loadModule = (): void => {
      if (window.gapi === undefined) {
        reject(new Error("Google API loader is unavailable"));
        return;
      }
      window.gapi.load("picker", {
        callback: () => {
          const namespace = window.google?.picker;
          if (namespace === undefined) {
            reject(new Error("Google Picker API did not initialize"));
          } else {
            resolve(namespace);
          }
        },
        onerror: () => { reject(new Error("Google Picker API failed to load")); },
        timeout: 10_000,
        ontimeout: () => { reject(new Error("Google Picker API load timed out")); },
      });
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-nago-google-picker="true"]',
    );
    if (existing !== null) {
      if (window.gapi !== undefined) {
        loadModule();
        return;
      }
      existing.addEventListener("load", loadModule, { once: true });
      existing.addEventListener(
        "error",
        () => { reject(new Error("Google API script failed to load")); },
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.dataset.nagoGooglePicker = "true";
    script.addEventListener("load", loadModule, { once: true });
    script.addEventListener(
      "error",
      () => { reject(new Error("Google API script failed to load")); },
      { once: true },
    );
    document.head.append(script);
  }).catch((error: unknown) => {
    pickerApiPromise = null;
    throw error;
  });
  pickerApiPromise = loading;
  return loading;
}
