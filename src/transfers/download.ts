import { GuestDownloadCheckpointSchema } from "./schemas.ts";
import {
  withDeadline,
  waitFor,
  type RequestOptions,
  type RequestScope,
  type CallOptions,
  decode,
} from "../protocol/index.ts";
import {
  ApiError,
  assertNotAborted,
  type TransportResponse,
  type Transport,
} from "../protocol/index.ts";
import type { AccountClient } from "../session/index.ts";
import { Files, CrUri } from "../files/index.ts";

/** @public */
export interface DownloadState {
  endpoint: string;
  uri: string;
  entity: string;
  name: string;
  size: number;
  etag?: string;
  completed: boolean;
}

/** @public */
export interface DownloadCheckpoint extends DownloadState {
  accountId: string;
}

/** Anonymous identity is explicit; this checkpoint never contains a share password. @public */
export interface GuestDownloadCheckpoint extends DownloadState {
  scope: "guest";
}

/** @public */
export interface DownloadDestination {
  size(): number;
  reset(): Promise<void>;
  append(bytes: Uint8Array): Promise<void>;
  receive?(
    response: TransportResponse,
    offset: number,
    remaining: number,
    progress: (loaded: number) => void,
  ): Promise<number>;
  close(): Promise<void>;
}

/** Byte-range decisions stay portable; adapters provide a streamed response and durable sink. */
/** @public */
class DownloadCore {
  private files: Files;

  constructor(
    private client: RequestScope,
    private storage: Transport,
  ) {
    this.files = new Files(client);
  }

  async prepare(uri: string, entity?: string, options?: CallOptions): Promise<DownloadState> {
    const file = await this.files.info(uri, options);

    const version = entity
      ? file.extended_info?.entities?.find((version) => version.id === entity)
      : undefined;

    if (file.type !== 0 || (entity && !version)) {
      throw new ApiError(-1, "File version is unavailable");
    }

    const selected = entity ?? file.primary_entity;
    const size = version?.size ?? file.size;

    if (typeof selected !== "string" || !selected || !Number.isSafeInteger(size) || size < 0) {
      throw new ApiError(-1, "Invalid download source");
    }

    return {
      endpoint: this.client.endpoint,
      uri: file.path,
      entity: selected,
      name: file.name,
      size,
      completed: false,
    };
  }

  async run<T extends DownloadState>(
    job: T,
    destination: DownloadDestination,
    save: (next: T) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
    options: Pick<RequestOptions, "timeoutMs"> = {},
  ): Promise<T> {
    if (options.timeoutMs === undefined || options.timeoutMs === 0) {
      return this.runScoped(job, destination, save, progress, signal);
    }

    return withDeadline(
      (combined) => this.runScoped(job, destination, save, progress, combined),
      { signal, timeoutMs: options.timeoutMs ?? 0 },
      this.client.signal,
    );
  }

  private async runScoped<T extends DownloadState>(
    job: T,
    destination: DownloadDestination,
    save: (checkpoint: T) => Promise<void>,
    progress: (loaded: number) => void,
    cancellation: AbortSignal,
  ): Promise<T> {
    if (job.endpoint !== this.client.endpoint) {
      throw new ApiError(-1, "Download belongs to another endpoint");
    }

    if (
      typeof job.entity !== "string" ||
      !job.entity ||
      !Number.isSafeInteger(job.size) ||
      job.size < 0
    ) {
      throw new ApiError(-1, "Invalid download source");
    }

    const controller = new AbortController();

    const abort = () => controller.abort();

    cancellation.addEventListener("abort", abort, { once: true });
    this.client.signal.addEventListener("abort", abort, { once: true });

    if (cancellation.aborted || this.client.signal.aborted) {
      abort();
    }

    const signal = controller.signal;
    let response: TransportResponse | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      assertNotAborted(signal);

      let offset = destination.size();

      if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.size) {
        throw new ApiError(-1, "Invalid partial download; remove it and retry");
      }

      if (job.completed && offset === job.size) {
        return job;
      }

      const headers = new Headers();

      if (offset > 0) {
        headers.set("Range", `bytes=${offset}-`);

        if (job.etag) {
          headers.set("If-Range", job.etag);
        }
      }

      const send = async (fresh = false) => {
        // A renewed URL is always resolved for the original entity, never the latest version.
        const [url] = await this.files.urls([job.uri], true, job.entity, fresh, { signal });

        if (!url) {
          throw new ApiError(-1, "No download URL");
        }

        assertNotAborted(signal);

        return waitFor(
          this.storage(url, { headers, signal, credentials: "omit" }).then((value) => {
            if (signal.aborted) {
              void value.body?.cancel().catch(() => {});
              assertNotAborted(signal);
            }

            return value;
          }),
          signal,
        );
      };

      response = await send();

      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        response = await send(true);
      }

      if (response.status === 416 && offset === job.size) {
        if (
          response.headers.get("Content-Range") !== `bytes */${job.size}` ||
          (job.etag && response.headers.get("ETag") !== job.etag)
        ) {
          throw new ApiError(-1, "Server returned an incompatible completed range");
        }

        await response.body?.cancel();
      } else {
        if (!response.ok) {
          throw new ApiError(response.status, `Download failed (${response.status})`);
        }

        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get("Content-Range") ?? "",
          );

          if (
            !range ||
            Number(range[1]) !== offset ||
            Number(range[2]) !== job.size - 1 ||
            Number(range[3]) !== job.size
          ) {
            throw new ApiError(-1, "Server returned an incompatible byte range");
          }

          if (job.etag && response.headers.get("ETag") !== job.etag) {
            throw new ApiError(-1, "Download source changed; restart required");
          }
        } else if (response.status === 200) {
          if (offset > 0) {
            await destination.reset();
          }

          offset = 0;
        } else {
          throw new ApiError(-1, "Unexpected download response");
        }

        const etag = response.headers.get("ETag") ?? undefined;

        job = { ...job, etag, completed: false };
        await save(job);
        assertNotAborted(signal);

        if (destination.receive) {
          const start = offset;

          offset += await destination.receive(response, start, job.size - start, (loaded) =>
            progress(start + loaded),
          );
        } else {
          if (!response.body && job.size !== 0) {
            throw new ApiError(-1, "Streaming download is unavailable");
          }

          reader = response.body?.getReader();

          while (reader) {
            assertNotAborted(signal);

            const next = await waitFor(reader.read(), signal);

            assertNotAborted(signal);

            if (next.done) {
              break;
            }

            if (offset + next.value.byteLength > job.size) {
              throw new ApiError(-1, "Download exceeded the expected size");
            }

            await waitFor(destination.append(next.value), signal);
            offset += next.value.byteLength;
            progress(offset);
          }
        }

        progress(offset);

        if (offset !== job.size) {
          throw new ApiError(-1, "Download was interrupted before completion");
        }
      }

      assertNotAborted(signal);
      await destination.close();
      assertNotAborted(signal);

      const completed = { ...job, completed: true };

      await save(completed);

      return completed;
    } finally {
      try {
        if (reader) {
          await reader.cancel().catch(() => {});
        } else {
          await response?.body?.cancel().catch(() => {});
        }

        await destination.close();
      } finally {
        cancellation.removeEventListener("abort", abort);
        this.client.signal.removeEventListener("abort", abort);
      }
    }
  }
}

/** Account-bound resumable downloads. @public */
export class Downloads {
  private core: DownloadCore;

  constructor(
    private client: AccountClient,
    storage: Transport,
  ) {
    this.core = new DownloadCore(client, storage);
  }

  async prepare(uri: string, entity?: string, options?: CallOptions): Promise<DownloadCheckpoint> {
    return {
      ...(await this.core.prepare(uri, entity, options)),
      accountId: this.client.accountId,
    };
  }

  async run(
    job: DownloadCheckpoint,
    destination: DownloadDestination,
    save: (next: DownloadCheckpoint) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
    options: Pick<RequestOptions, "timeoutMs"> = {},
  ): Promise<DownloadCheckpoint> {
    if (
      job.accountId !== this.client.accountId ||
      job.endpoint !== this.client.endpoint ||
      ("scope" in job && job.scope !== undefined)
    ) {
      throw new ApiError(-1, "Download belongs to another account");
    }

    return this.core.run(job, destination, save, progress, signal, options);
  }
}

function guestUri(value: string): CrUri {
  try {
    const uri = new CrUri(value);

    if (uri.fs() !== "share" || !uri.id()) {
      throw Error("Not a share");
    }

    return uri;
  } catch (error) {
    throw new ApiError(-1, "Guest downloads require a share URI", undefined, undefined, undefined, {
      kind: "validation",
      cause: error,
    });
  }
}

/** Validate persisted guest state; passwords are supplied separately for each run. @public */
export function parseGuestDownloadCheckpoint(value: unknown): GuestDownloadCheckpoint {
  const job = decode(GuestDownloadCheckpointSchema, value, "Invalid guest download checkpoint");

  if (guestUri(job.uri).password()) {
    throw new ApiError(-1, "Guest checkpoints must not contain passwords");
  }

  return job;
}

/** Use through createPublicClient to ensure anonymous transport isolation. @public */
export class GuestDownloads {
  private core: DownloadCore;

  constructor(client: RequestScope, storage: Transport) {
    this.core = new DownloadCore(client, (url, init) =>
      storage(url, { ...init, credentials: "omit", redirect: "error" }),
    );
  }

  async prepare(
    uri: string,
    entity?: string,
    options?: CallOptions,
  ): Promise<GuestDownloadCheckpoint> {
    const parsed = guestUri(uri);
    const data = await this.core.prepare(parsed.toString(), entity, options);

    return { ...data, scope: "guest", uri: parsed.withPassword("").toString() };
  }

  async run(
    input: GuestDownloadCheckpoint,
    destination: DownloadDestination,
    save: (next: GuestDownloadCheckpoint) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
    options: { password?: string; timeoutMs?: number } = {},
  ): Promise<GuestDownloadCheckpoint> {
    const job = parseGuestDownloadCheckpoint(input);
    const uri = job.uri;

    const transient = {
      ...job,
      uri: guestUri(uri)
        .withPassword(options.password ?? "")
        .toString(),
    };

    const result = await this.core.run(
      transient,
      destination,
      (next) => save({ ...next, uri }),
      progress,
      signal,
      options,
    );

    return { ...result, uri };
  }
}
