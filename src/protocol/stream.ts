import { ApiError, assertNotAborted, waitFor } from "./execution.ts";

/** Maximum UTF-8 bytes per SSE frame, matching the bounded JSON control-plane budget. @public */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** @public */
export interface ServerEventFrame {
  event: string;
  data: string;
}

/** Parse bounded SSE frames across arbitrary UTF-8, LF/CRLF/CR transport boundaries. @public */
export async function* readSSE(
  response: Pick<Response, "body">,
  signal: AbortSignal,
): AsyncGenerator<ServerEventFrame> {
  if (!response.body) {
    throw new ApiError(-1, "Streaming response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let bytes = 0;

  try {
    while (true) {
      const next = await waitFor(reader.read(), signal).catch((error) => {
        assertNotAborted(signal);

        throw new ApiError(0, "Event transport interrupted", undefined, undefined, undefined, {
          kind: "transport",
          cause: error,
        });
      });

      try {
        buffer += decoder.decode(next.value, { stream: !next.done });
      } catch (error) {
        throw new ApiError(-1, "Invalid UTF-8 server event", undefined, undefined, undefined, {
          kind: "validation",
          cause: error,
        });
      }

      while (true) {
        const match = /\r\n|\r|\n/.exec(buffer);

        if (!match || (!next.done && match[0] === "\r" && match.index === buffer.length - 1)) {
          break;
        }

        const line = buffer.slice(0, match.index);

        buffer = buffer.slice(match.index + match[0].length);
        bytes += encoder.encode(line).length + match[0].length;

        if (bytes > MAX_EVENT_BYTES) {
          throw new ApiError(-1, "Server event exceeds the byte limit");
        }

        if (!line) {
          if (data.length) {
            yield { event, data: data.join("\n") };
          }

          event = "message";
          data = [];
          bytes = 0;
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);

        let value = colon < 0 ? "" : line.slice(colon + 1);

        if (value.startsWith(" ")) {
          value = value.slice(1);
        }

        if (field === "event") {
          event = value;
        }

        if (field === "data") {
          data.push(value);
        }
      }

      if (bytes + encoder.encode(buffer).length > MAX_EVENT_BYTES) {
        throw new ApiError(-1, "Server event exceeds the byte limit");
      }

      if (next.done) {
        if (data.length || buffer) {
          throw new ApiError(-1, "Incomplete server event");
        }

        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { resolve, promise };
}

/** Adapt a response-consumption callback to a lazy iterator with one-item backpressure. @public */
export async function* streamValues<T>(
  run: (emit: (value: T) => Promise<void>, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal | null,
): AsyncGenerator<T> {
  const controller = new AbortController();

  const abort = () => controller.abort(signal?.reason);

  signal?.addEventListener("abort", abort, { once: true });

  if (signal?.aborted) {
    abort();
  }

  let ready = deferred();
  let ack = deferred();
  let slot: { value: T } | undefined;
  let done = false;
  let failure: unknown;
  let failed = false;

  const running = Promise.resolve()
    .then(() => {
      assertNotAborted(controller.signal);

      return run(async (value) => {
        assertNotAborted(controller.signal);
        slot = { value };
        ack = deferred();
        ready.resolve();
        await waitFor(ack.promise, controller.signal);
      }, controller.signal);
    })
    .then(
      () => {
        done = true;
      },
      (error) => {
        done = true;
        failure = error;
        failed = true;
      },
    )
    .finally(() => {
      controller.abort();
      ready.resolve();
    });

  try {
    while (true) {
      await ready.promise;

      if (slot) {
        const value = slot.value;

        slot = undefined;
        ready = deferred();
        yield value;
        ack.resolve();
      } else if (done) {
        if (failed) {
          throw failure;
        }

        return;
      }
    }
  } finally {
    controller.abort();
    ack.resolve();
    signal?.removeEventListener("abort", abort);
    await running;
  }
}
