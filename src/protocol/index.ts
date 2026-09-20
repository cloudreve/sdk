import {
  ApiError,
  assertNotAborted,
  waitFor,
  withDeadline,
  type RequestOptions,
} from "./execution.ts";
import { decode, EnvelopeSchema } from "./schema.ts";

export { ApiError, assertNotAborted, waitFor, withDeadline } from "./execution.ts";

/** @public */
export type { RequestOptions, ErrorKind } from "./execution.ts";

export { decode, nonempty, natural, finite } from "./schema.ts";

/** @public */
export interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
  error?: string;
  correlation_id?: string;
  aggregated_error?: unknown;
}

/** @public */
export type TransportResponse = Pick<
  Response,
  "ok" | "status" | "statusText" | "headers" | "body" | "json" | "text"
>;

/** @public */
export type Transport = (url: string, init?: RequestInit) => Promise<TransportResponse>;

/** @public */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(-1, "Invalid server response");
  }

  return value as Record<string, unknown>;
}

async function boundedText(
  response: TransportResponse,
  signal: AbortSignal,
  limit: number,
  truncate = false,
): Promise<string> {
  if (!response.body) {
    return waitFor(response.text(), signal);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];

  let size = 0;

  try {
    while (true) {
      const next = await waitFor(reader.read(), signal);

      if (next.done) {
        break;
      }

      const remaining = limit - size;

      chunks.push(next.value.subarray(0, remaining));
      size += next.value.length;

      if (size > limit) {
        if (!truncate) {
          throw new ApiError(-1, "Response exceeds the byte limit");
        }

        size = limit;
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let at = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  return new TextDecoder().decode(bytes);
}

async function responseValue(response: TransportResponse, signal: AbortSignal): Promise<unknown> {
  try {
    return response.body
      ? JSON.parse(await boundedText(response, signal, 8 * 1024 * 1024))
      : await waitFor(response.json(), signal);
  } catch (error) {
    assertNotAborted(signal);

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(-1, "Invalid JSON response", undefined, undefined, undefined, {
      kind: "validation",
      cause: error,
    });
  }
}

/** @public */
export async function request<T>(
  transport: Transport,
  url: string,
  init: RequestOptions = {},
  raw = false,
  consume?: ResponseConsumer<T>,
): Promise<T> {
  const {
    timeoutMs: _timeout,
    retry: _retry,
    maxRetries: _max,
    replayable: _replay,
    ...wireInit
  } = init;

  return withDeadline(async (signal) => {
    const headers = new Headers(init.headers);

    if (!raw && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const safe =
      init.retry === "safe" ||
      (init.retry !== "never" && ["GET", "HEAD"].includes(init.method ?? "GET"));

    const replayable = init.replayable ?? (!init.body || typeof init.body === "string");
    const retries = init.maxRetries ?? 2;

    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) {
      throw new ApiError(-1, "Invalid retry limit");
    }

    for (let attempt = 0; ; attempt++) {
      let response: TransportResponse;

      try {
        response = await waitFor(transport(url, { ...wireInit, headers, signal }), signal);
      } catch (error) {
        assertNotAborted(signal);

        if (!safe || !replayable || attempt >= retries) {
          throw new ApiError(
            0,
            error instanceof Error ? error.message : "Network request failed",
            undefined,
            undefined,
            undefined,
            { kind: "transport", cause: error },
          );
        }

        await delay(attempt, signal);
        continue;
      }

      if (!response.ok) {
        if (
          safe &&
          replayable &&
          attempt < retries &&
          [429, 500, 502, 503, 504].includes(response.status)
        ) {
          void response.body?.cancel().catch(() => {});
          await delay(attempt, signal, response.headers?.get("Retry-After"));
          continue;
        }

        let message = `HTTP ${response.status}${response.statusText ? ": " + response.statusText : ""}`;
        let detail: Record<string, unknown> | undefined;

        try {
          const text = await boundedText(response, signal, 4096, true);

          if (raw && text) {
            message = text;
          }

          try {
            detail = record(JSON.parse(text));

            if (!raw && typeof detail.msg === "string" && detail.msg) {
              message = detail.msg;
            }
          } catch {
            /* HTTP status remains authoritative. */
          }
        } catch {
          assertNotAborted(signal);
        }

        throw new ApiError(
          response.status,
          message,
          typeof detail?.correlation_id === "string" ? detail.correlation_id : undefined,
          detail?.data,
          detail?.aggregated_error,
          {
            kind: "http",
            httpStatus: response.status,
            apiCode: typeof detail?.code === "number" ? detail.code : undefined,
          },
        );
      }

      if (consume) {
        return consume(response, signal);
      }

      if (response.headers?.get("Content-Type")?.includes("text/event-stream")) {
        void response.body?.cancel();

        throw new ApiError(
          -1,
          "Streaming directory responses require the streaming operation",
          undefined,
          undefined,
          undefined,
          { kind: "unsupported" },
        );
      }

      return responseData<T>(response, signal, raw);
    }
  }, init);
}

/** @public */
export type ResponseConsumer<T> = (response: TransportResponse, signal: AbortSignal) => Promise<T>;

/** Decode a bounded JSON API envelope from a response held by the request lifetime. @public */
export async function responseData<T>(
  response: TransportResponse,
  signal: AbortSignal,
  raw = false,
): Promise<T> {
  const value = await responseValue(response, signal);

  if (raw) {
    return value as T;
  }

  const envelope = decode(EnvelopeSchema, value);

  if (envelope.code !== 0) {
    throw new ApiError(
      envelope.code,
      typeof envelope.msg === "string" && envelope.msg
        ? envelope.msg
        : typeof envelope.error === "string" && envelope.error
          ? envelope.error
          : "Server operation failed",
      envelope.correlation_id,
      envelope.data ?? envelope.aggregated_error,
      envelope.aggregated_error,
      { kind: "api", httpStatus: response.status, apiCode: envelope.code },
    );
  }

  return envelope.data as T;
}

async function delay(attempt: number, signal: AbortSignal, retryAfter?: string | null) {
  const numeric = Number(retryAfter);

  const header =
    retryAfter && Number.isNaN(numeric) ? (Date.parse(retryAfter) - Date.now()) / 1000 : numeric;

  const ms =
    retryAfter && Number.isFinite(header)
      ? Math.min(Math.max(header * 1000, 0), 2000)
      : Math.min(100 * 2 ** attempt, 1000) * (0.5 + Math.random() / 2);

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await waitFor(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export { Boolset } from "./boolset.ts";

export { toRequestOptions } from "./execution.ts";

export type { CallOptions, OperationOptions } from "./execution.ts";

export { readSSE, streamValues, type ServerEventFrame } from "./stream.ts";

/** Minimal request lifetime shared by authenticated and anonymous resources. @public */
export interface RequestScope {
  readonly endpoint: string;
  readonly signal: AbortSignal;
  request<T>(path: string, init?: RequestOptions, raw?: boolean): Promise<T>;
  consume<T>(path: string, consumer: ResponseConsumer<T>, init?: RequestOptions): Promise<T>;
}
