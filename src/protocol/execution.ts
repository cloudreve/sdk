/** Per-operation settings; retry eligibility is independent of body replayability. */
/** @public */
export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  retry?: "safe" | "never";
  maxRetries?: number;
  replayable?: boolean;
}

/** @public */
export type ErrorKind =
  | "transport"
  | "http"
  | "api"
  | "validation"
  | "cancelled"
  | "timeout"
  | "unsupported"
  | "storage"
  | "authentication";

/** @public */
export class ApiError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus?: number;
  readonly apiCode?: number;
  readonly phase?: "persistence" | "revocation";

  constructor(
    public code: number,
    message: string,
    public correlationId?: string,
    public data?: unknown,
    public aggregatedError?: unknown,
    details: {
      kind?: ErrorKind;
      httpStatus?: number;
      apiCode?: number;
      cause?: unknown;
      phase?: "persistence" | "revocation";
    } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "ApiError";
    this.phase = details.phase;

    this.kind =
      details.kind ??
      (code === 499 ? "cancelled" : code >= 40000 ? "api" : code >= 100 ? "http" : "validation");

    this.httpStatus = details.httpStatus ?? (this.kind === "http" ? code : undefined);
    this.apiCode = details.apiCode ?? (this.kind === "api" ? code : undefined);
  }
}

/** @public */
export function assertNotAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw signal.reason instanceof ApiError
      ? signal.reason
      : new ApiError(499, "Operation cancelled");
  }
}

/** Cancellation of one waiter never cancels the shared operation it is awaiting. */
/** @public */
export async function waitFor<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal?.aborted) {
    void pending.catch(() => {});
    assertNotAborted(signal);
  }

  if (!signal) {
    return pending;
  }

  let abort!: () => void;

  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      try {
        assertNotAborted(signal);
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** @public */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RequestOptions = {},
  lifetime?: AbortSignal,
): Promise<T> {
  const timeout = options.timeoutMs ?? 30_000;

  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new ApiError(-1, "Invalid timeout");
  }

  const controller = new AbortController();
  const sources = [options.signal, lifetime].filter((s): s is AbortSignal => !!s);

  const listeners = sources.map((source) => {
    const abort = () => controller.abort(source.reason);

    source.addEventListener("abort", abort, { once: true });

    if (source.aborted) {
      abort();
    }

    return abort;
  });

  const timer = timeout
    ? setTimeout(
        () =>
          controller.abort(
            new ApiError(-1, "Request timed out", undefined, undefined, undefined, {
              kind: "timeout",
            }),
          ),
        timeout,
      )
    : undefined;

  try {
    assertNotAborted(controller.signal);

    return await waitFor(operation(controller.signal), controller.signal);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    sources.forEach((s, i) => s.removeEventListener("abort", listeners[i]!));
  }
}

/** @public */
export type OperationOptions = Pick<
  RequestOptions,
  "signal" | "timeoutMs" | "maxRetries" | "retry" | "headers"
>;

/** @public */
export type CallOptions = OperationOptions | AbortSignal;

/** Preserve signal-only resource calls while accepting uniform operation options. @public */
export function toRequestOptions(value?: CallOptions): RequestOptions {
  if (value && "aborted" in value) {
    return { signal: value };
  }

  if (!value) {
    return {};
  }

  const { signal, timeoutMs, maxRetries, retry, headers } = value;

  return { signal, timeoutMs, maxRetries, retry, headers };
}
