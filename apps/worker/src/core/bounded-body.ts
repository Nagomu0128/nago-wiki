import { ApiProblem } from "./errors";

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedBytes(request, maxBytes),
    );
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new ApiProblem("INVALID_REQUEST", 400, "Request body must be valid UTF-8");
  }
}

export async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = parseDeclaredLength(request.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new ApiProblem("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
  }
  if (request.body === null) {
    if (declaredLength !== null && declaredLength !== 0) {
      throw new ApiProblem("INVALID_REQUEST", 400, "Request body length does not match Content-Length");
    }
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      received += result.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new ApiProblem("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && declaredLength !== received) {
    throw new ApiProblem("INVALID_REQUEST", 400, "Request body length does not match Content-Length");
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseDeclaredLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d{1,10}$/u.test(value)) {
    throw new ApiProblem("INVALID_REQUEST", 400, "Invalid Content-Length header");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ApiProblem("INVALID_REQUEST", 400, "Invalid Content-Length header");
  }
  return length;
}
