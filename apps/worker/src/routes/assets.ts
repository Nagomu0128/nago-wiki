import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { Hono } from "hono";

import { AuthorizationService, canEdit, canView } from "../core/authorization";
import {
  requireIdentity,
  type CoreHonoEnv,
} from "../core/context";
import { ApiProblem } from "../core/errors";
import { D1WikiRepository, pageNotFound } from "../core/repository";

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const assetIdPattern = /^[0-9a-f-]{36}$/u;

const safeMimeTypes = new Map<string, { extension: string; disposition: "inline" | "attachment" }>([
  ["image/png", { extension: ".png", disposition: "inline" }],
  ["image/jpeg", { extension: ".jpg", disposition: "inline" }],
  ["image/gif", { extension: ".gif", disposition: "inline" }],
  ["image/webp", { extension: ".webp", disposition: "inline" }],
  ["application/pdf", { extension: ".pdf", disposition: "attachment" }],
]);

export function createAssetRoutes(): Hono<CoreHonoEnv> {
  const routes = new Hono<CoreHonoEnv>();

  routes.post("/pages/:id/assets", async (context) => {
    const identity = requireIdentity(context);
    await requirePagePermission(context.env, identity, context.req.param("id"), true);
    const declaredLength = parseContentLength(context.req.header("content-length"));
    if (declaredLength === null) {
      throw new ApiProblem(
        "CONTENT_LENGTH_REQUIRED",
        411,
        "Asset uploads require a valid Content-Length header",
      );
    }
    if (declaredLength < 1 || declaredLength > MAX_ASSET_BYTES) {
      throw new ApiProblem("ASSET_TOO_LARGE", 413, "Asset size must be between 1 byte and 10 MiB");
    }
    const contentType = normalizeContentType(context.req.header("content-type"));
    const policy = contentType === null ? undefined : safeMimeTypes.get(contentType);
    if (contentType === null || policy === undefined) {
      throw new ApiProblem("UNSUPPORTED_ASSET_TYPE", 415, "Unsupported asset type");
    }
    const originalName = context.req.header("x-file-name") ?? `asset${policy.extension}`;
    const filename = safeAssetFilename(originalName, policy.extension);
    const bytes = await readBodyWithinLimit(context.req.raw.body, declaredLength);
    if (!matchesMagicBytes(contentType, bytes)) {
      throw new ApiProblem("INVALID_ASSET", 400, "Asset content does not match its declared type");
    }
    const assetId = crypto.randomUUID();
    const pageId = context.req.param("id");
    const key = assetKey(identity.workspaceId, pageId, assetId, filename);
    const uploadedAt = new Date().toISOString();
    const sha256 = await sha256Hex(bytes);
    await context.env.FILES.put(key, bytes, {
      httpMetadata: {
        contentType,
        contentDisposition: `${policy.disposition}; filename="${filename}"`,
      },
      customMetadata: {
        workspaceId: identity.workspaceId,
        pageId,
        assetId,
        originalName: originalName.slice(0, 500),
        uploadedBy: identity.id,
        uploadedAt,
        sha256,
      },
    });
    return context.json({
      id: assetId,
      filename,
      contentType,
      size: bytes.byteLength,
      sha256,
      url: `/api/v1/pages/${encodeURIComponent(pageId)}/assets/${encodeURIComponent(assetId)}/${encodeURIComponent(filename)}`,
      uploadedAt,
    }, 201);
  });

  routes.get("/pages/:id/assets/:assetId/:filename", async (context) => {
    const identity = requireIdentity(context);
    await requirePagePermission(context.env, identity, context.req.param("id"), false);
    const assetId = requireAssetId(context.req.param("assetId"));
    const filename = requireSafeFilename(context.req.param("filename"));
    const object = await context.env.FILES.get(
      assetKey(identity.workspaceId, context.req.param("id"), assetId, filename),
    );
    if (object === null) throw pageNotFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  });

  routes.delete("/pages/:id/assets/:assetId/:filename", async (context) => {
    const identity = requireIdentity(context);
    await requirePagePermission(context.env, identity, context.req.param("id"), true);
    const assetId = requireAssetId(context.req.param("assetId"));
    const filename = requireSafeFilename(context.req.param("filename"));
    await context.env.FILES.delete(
      assetKey(identity.workspaceId, context.req.param("id"), assetId, filename),
    );
    return context.body(null, 204);
  });

  return routes;
}

async function requirePagePermission(
  environment: CoreHonoEnv["Bindings"],
  identity: AuthenticatedIdentity,
  pageId: string,
  edit: boolean,
): Promise<void> {
  const repository = new D1WikiRepository(environment.DB);
  const page = await repository.getPage(pageId);
  if (page?.workspaceId !== identity.workspaceId || page.status !== "active") {
    throw pageNotFound();
  }
  const permission = await new AuthorizationService(repository).effectivePermission(
    identity,
    pageId,
  );
  if (edit ? !canEdit(permission) : !canView(permission)) throw pageNotFound();
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeContentType(value: string | undefined): string | null {
  return value?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? null;
}

async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number,
): Promise<Uint8Array> {
  if (body === null) {
    throw new ApiProblem("INVALID_ASSET", 400, "Asset body is missing");
  }
  const output = new Uint8Array(declaredLength);
  const reader = body.getReader();
  let offset = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      if (offset + result.value.byteLength > declaredLength) {
        await reader.cancel();
        throw new ApiProblem("INVALID_ASSET", 400, "Asset size does not match Content-Length");
      }
      output.set(result.value, offset);
      offset += result.value.byteLength;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== declaredLength) {
    throw new ApiProblem("INVALID_ASSET", 400, "Asset size does not match Content-Length");
  }
  return output;
}

export function safeAssetFilename(value: string, requiredExtension: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "asset";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 160);
  const fallback = normalized.length === 0 ? "asset" : normalized;
  return fallback.toLocaleLowerCase("en-US").endsWith(requiredExtension)
    ? fallback
    : `${fallback}${requiredExtension}`;
}

export function matchesMagicBytes(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (contentType === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (contentType === "application/pdf") return ascii(bytes, 0, 5) === "%PDF-";
  return false;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCodePoint(...bytes.slice(offset, offset + length));
}

function requireAssetId(value: string): string {
  if (!assetIdPattern.test(value)) throw pageNotFound();
  return value;
}

function requireSafeFilename(value: string): string {
  if (value.length < 1 || value.length > 200 || value !== safeAssetFilename(value, "")) {
    throw pageNotFound();
  }
  return value;
}

function assetKey(workspaceId: string, pageId: string, assetId: string, filename: string): string {
  return `assets/${workspaceId}/${pageId}/${assetId}/${filename}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
