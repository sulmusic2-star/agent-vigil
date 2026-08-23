const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
} as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(body: object, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    const additions = new Headers(extraHeaders);
    additions.forEach((value, key) => headers.set(key, value));
  }
  return Response.json(body, { status, headers });
}

export function errorResponse(error: ApiError, requestId: string): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: requestId
      }
    },
    error.status
  );
}

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("body limit exceeded");
        throw new ApiError(413, "request_too_large", "Request body exceeds the allowed size.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(400, "invalid_body", "Request body must be valid UTF-8.");
  } finally {
    reader.releaseLock();
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_json_shape", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export async function readJsonObject(request: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBoundedText(request, maxBytes));
}

export function assertMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new ApiError(405, "method_not_allowed", `Use ${method} for this route.`);
  }
}
