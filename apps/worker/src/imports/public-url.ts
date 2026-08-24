import { safeImportFilename } from "./filename";

const MAX_PUBLIC_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 4;

const blockedHostnames = new Set([
  "0",
  "instance-data",
  "localhost",
  "metadata",
  "metadata.google.internal",
]);
const blockedHostnameSuffixes = [
  ".home.arpa",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
];

export interface FetchedPublicDocument {
  bytes: Uint8Array;
  contentType: "application/pdf" | "text/html" | "text/markdown" | "text/plain";
  filename: string;
  finalUrl: string;
}

export function assertPublicHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Public URL imports only support HTTP and HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Public URL imports do not allow embedded credentials");
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    blockedHostnames.has(hostname) ||
    blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    isBlockedIpAddress(hostname)
  ) {
    throw new Error("Public URL import target is not publicly routable");
  }
  url.hash = "";
  return url;
}

export async function fetchPublicDocument(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<FetchedPublicDocument> {
  let current = assertPublicHttpUrl(input);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetcher(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html, text/markdown, text/plain, application/pdf;q=0.9",
        "User-Agent": "NagoWikiImporter/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (location === null) throw new Error("Public URL redirect has no location");
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("Public URL import exceeded the redirect limit");
      }
      current = assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Public URL returned HTTP ${String(response.status)}`);
    }
    const declaredLength = parseContentLength(response.headers.get("Content-Length"));
    if (declaredLength !== null && declaredLength > MAX_PUBLIC_DOCUMENT_BYTES) {
      await response.body?.cancel();
      throw new Error("Public URL document exceeds the 20 MiB import limit");
    }
    const contentType = normalizeContentType(
      response.headers.get("Content-Type"),
      current.pathname,
    );
    const bytes = await readLimitedBody(response.body, MAX_PUBLIC_DOCUMENT_BYTES);
    return {
      bytes,
      contentType,
      filename: filenameFromUrl(current, contentType),
      finalUrl: current.toString(),
    };
  }
  throw new Error("Public URL import exceeded the redirect limit");
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (body === null) throw new Error("Public URL returned an empty response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        continue;
      }
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response exceeds import limit");
        throw new Error("Public URL document exceeds the 20 MiB import limit");
      }
      chunks.push(result.value);
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

function normalizeContentType(
  header: string | null,
  pathname: string,
): FetchedPublicDocument["contentType"] {
  const value = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (value === "application/pdf") return value;
  if (value === "text/html" || value === "application/xhtml+xml") return "text/html";
  if (value === "text/markdown" || value === "text/x-markdown") {
    return "text/markdown";
  }
  if (value === "text/plain") return value;
  if (value === "application/octet-stream" && pathname.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  throw new Error("Public URL content type is not supported");
}

function filenameFromUrl(
  url: URL,
  contentType: FetchedPublicDocument["contentType"],
): string {
  const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
  if (lastSegment !== undefined) {
    try {
      const decoded = safeImportFilename(decodeURIComponent(lastSegment));
      if (decoded.length > 0) return decoded.slice(0, 255);
    } catch {
      // Use a deterministic filename for malformed percent-encoding.
    }
  }
  const extension =
    contentType === "application/pdf"
      ? "pdf"
      : contentType === "text/markdown"
        ? "md"
        : contentType === "text/html"
          ? "html"
          : "txt";
  return `imported-${url.hostname}.${extension}`.slice(0, 255);
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase().replace(/\.$/u, "");
  return lowered.startsWith("[") && lowered.endsWith("]")
    ? lowered.slice(1, -1)
    : lowered;
}

function isBlockedIpAddress(hostname: string): boolean {
  if (hostname.includes(":")) return isBlockedIpv6(hostname);
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const firstText = hostname.split(":", 1)[0] ?? "";
  const first = firstText === "" ? 0 : Number.parseInt(firstText, 16);
  if (!Number.isInteger(first)) return true;
  const globallyRoutable = first >= 0x2000 && first <= 0x3fff;
  return !globallyRoutable || hostname.toLowerCase().startsWith("2001:db8:");
}
