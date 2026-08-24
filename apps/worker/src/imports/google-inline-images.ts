import type { GoogleDocsInlineImage } from "./google-docs-parser";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 50;

export interface ImportedGoogleAsset {
  objectId: string;
  assetId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  stagingKey: string;
  finalKey: string;
  url: string;
  altText: string;
}

export interface GoogleImageImportResult {
  assets: ImportedGoogleAsset[];
  warnings: string[];
}

interface FinalizeGoogleAssetsOptions {
  files: R2Bucket;
  workspaceId: string;
  importId: string;
  pageId: string;
  uploadedBy: string;
  assets: ImportedGoogleAsset[];
}

interface ImportGoogleImagesOptions {
  files: ImportAssetStore;
  workspaceId: string;
  importId: string;
  targetPageId: string;
  images: GoogleDocsInlineImage[];
  fetchImage?: (url: string) => Promise<Response>;
}

interface ImportAssetStore {
  put(key: string, value: Uint8Array, options: R2PutOptions): Promise<unknown>;
}

export async function importGoogleInlineImages(
  options: ImportGoogleImagesOptions,
): Promise<GoogleImageImportResult> {
  const assets: ImportedGoogleAsset[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  const images = options.images.slice(0, MAX_IMAGES);
  if (options.images.length > MAX_IMAGES) {
    warnings.push(`Only the first ${String(MAX_IMAGES)} Google Docs images were imported.`);
  }

  for (const [index, image] of images.entries()) {
    try {
      const response = await (options.fetchImage ?? fetch)(image.contentUri);
      if (!response.ok || response.body === null) {
        throw new Error(`image request returned ${String(response.status)}`);
      }
      const declaredLength = parseContentLength(response.headers.get("content-length"));
      if (declaredLength !== null && declaredLength > MAX_IMAGE_BYTES) {
        await response.body.cancel();
        throw new Error("image exceeds the 10 MiB limit");
      }
      const bytes = await readStreamWithinLimit(response.body, MAX_IMAGE_BYTES);
      if (totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("document images exceed the 50 MiB total limit");
      }
      const policy = sniffImage(bytes);
      if (policy === null) throw new Error("image format is not supported");
      totalBytes += bytes.byteLength;
      const assetId = await stableAssetId(options.importId, image.objectId);
      const filename = `google-image-${String(index + 1)}${policy.extension}`;
      const sha256 = await sha256Hex(bytes);
      const stagingKey = importAssetKey(
        options.workspaceId,
        options.importId,
        assetId,
        filename,
      );
      const finalKey = pageAssetKey(
        options.workspaceId,
        options.targetPageId,
        assetId,
        filename,
      );
      await options.files.put(stagingKey, bytes, {
        httpMetadata: {
          contentType: policy.contentType,
          contentDisposition: `inline; filename="${filename}"`,
        },
        customMetadata: {
          importId: options.importId,
          sourceType: "google_docs",
          sourceObjectId: image.objectId.slice(0, 500),
          sha256,
        },
      });
      assets.push({
        objectId: image.objectId,
        assetId,
        filename,
        contentType: policy.contentType,
        size: bytes.byteLength,
        sha256,
        stagingKey,
        finalKey,
        url: `/api/v1/pages/${encodeURIComponent(options.targetPageId)}/assets/${encodeURIComponent(assetId)}/${encodeURIComponent(filename)}`,
        altText: image.altText,
      });
    } catch (error) {
      warnings.push(
        `Google Docs image ${image.objectId} was skipped: ${publicImageError(error)}`,
      );
    }
  }
  return { assets, warnings };
}

export function replaceGoogleInlineObjectLinks(
  markdown: string,
  objectIds: string[],
  assets: ImportedGoogleAsset[],
): string {
  const byObjectId = new Map(assets.map((asset) => [asset.objectId, asset]));
  let result = markdown;
  for (const objectId of objectIds) {
    const placeholder = `![Google Docs image](google-inline-object:${objectId})`;
    const asset = byObjectId.get(objectId);
    result = result.replaceAll(
      placeholder,
      asset === undefined
        ? "_[Google Docs image could not be imported]_"
        : `![${escapeMarkdownAlt(asset.altText)}](${asset.url})`,
    );
  }
  return result;
}

export async function finalizeGoogleImportAssets(
  options: FinalizeGoogleAssetsOptions,
): Promise<void> {
  for (const asset of options.assets) {
    const expectedStagingKey = importAssetKey(
      options.workspaceId,
      options.importId,
      asset.assetId,
      asset.filename,
    );
    const expectedFinalKey = pageAssetKey(
      options.workspaceId,
      options.pageId,
      asset.assetId,
      asset.filename,
    );
    if (
      asset.stagingKey !== expectedStagingKey ||
      asset.finalKey !== expectedFinalKey ||
      asset.url !== `/api/v1/pages/${encodeURIComponent(options.pageId)}/assets/${encodeURIComponent(asset.assetId)}/${encodeURIComponent(asset.filename)}`
    ) {
      throw new Error("Google import asset metadata is invalid");
    }
    const existing = await options.files.head(expectedFinalKey);
    if (
      existing?.size === asset.size &&
      existing.customMetadata?.sha256 === asset.sha256
    ) {
      continue;
    }
    const source = await options.files.get(expectedStagingKey);
    if (
      source?.size !== asset.size ||
      source.customMetadata?.sha256 !== asset.sha256
    ) {
      throw new Error("A staged Google import image is unavailable");
    }
    await options.files.put(expectedFinalKey, source.body, {
      httpMetadata: source.httpMetadata ?? {
        contentType: asset.contentType,
        contentDisposition: `inline; filename="${asset.filename}"`,
      },
      customMetadata: {
        workspaceId: options.workspaceId,
        pageId: options.pageId,
        assetId: asset.assetId,
        originalName: asset.filename,
        uploadedBy: options.uploadedBy,
        uploadedAt: new Date().toISOString(),
        sha256: asset.sha256,
        importId: options.importId,
      },
    });
  }
}

function importAssetKey(
  workspaceId: string,
  importId: string,
  assetId: string,
  filename: string,
): string {
  return `imports/${workspaceId}/${importId}/assets/${assetId}/${filename}`;
}

function pageAssetKey(
  workspaceId: string,
  pageId: string,
  assetId: string,
  filename: string,
): string {
  return `assets/${workspaceId}/${pageId}/${assetId}/${filename}`;
}

function sniffImage(bytes: Uint8Array): { contentType: string; extension: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: "image/png", extension: ".png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }
  const prefix = ascii(bytes, 0, 6);
  if (prefix === "GIF87a" || prefix === "GIF89a") {
    return { contentType: "image/gif", extension: ".gif" };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { contentType: "image/webp", extension: ".webp" };
  }
  return null;
}

async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("image exceeds the 10 MiB limit");
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d{1,12}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function stableAssetId(importId: string, objectId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${importId}\u0000${objectId}`),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCodePoint(...bytes.slice(offset, offset + length));
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/([\\\]])/gu, "\\$1").slice(0, 500);
}

function publicImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : "image download failed";
  return message.replace(/https?:\/\/\S+/giu, "[redacted URL]").slice(0, 300);
}
