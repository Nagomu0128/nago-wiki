import { HTTPException } from "hono/http-exception";

// Keep buffered JSON well below a Worker isolate's shared 128 MiB memory limit.
// Larger documents must use a streaming upload path rather than this endpoint.
export const MAX_IMPORT_REQUEST_BYTES = 6 * 1024 * 1024;

export async function readBoundedImportJson(
  request: Request,
  maxBytes = MAX_IMPORT_REQUEST_BYTES,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw tooLarge();
  }
  if (request.body === null) {
    throw new HTTPException(400, { message: "Import request must be JSON" });
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let byteLength = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("Import request is too large").catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
      result = await reader.read();
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, {
      message: "Import request must be valid UTF-8 JSON",
    });
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    throw new HTTPException(400, {
      message: "Import request must be valid JSON",
    });
  }
}

function tooLarge(): HTTPException {
  return new HTTPException(413, { message: "Import request is too large" });
}
