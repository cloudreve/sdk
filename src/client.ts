import { AccountClient, type SessionOptions } from "./session/index.ts";
import { Files, CrUri, childUri, validateName, type ListOptions } from "./files/index.ts";
import { Uploads, Downloads, GuestDownloads } from "./transfers/index.ts";
import { Shares } from "./shares/index.ts";
import { Jobs } from "./jobs/index.ts";
import { Profile } from "./profile/index.ts";
import { WebDAV } from "./webdav/index.ts";
import {
  ApiError,
  request,
  withDeadline,
  toRequestOptions,
  type Transport,
  type RequestScope,
  type RequestOptions,
  type ResponseConsumer,
  type CallOptions,
} from "./protocol/index.ts";

/** Transport and session dependencies for an authenticated client. @public */
export interface ClientOptions extends SessionOptions {
  storageTransport?: Transport;
  downloadTransport?: Transport;
}

/** Restore the session before returning account-bound resources. @public */
export async function createClient(options: ClientOptions) {
  const session = new AccountClient(options);

  await session.ready();

  const storage = options.storageTransport ?? options.transport;

  return {
    session,
    files: new Files(session),
    uploads: new Uploads(session, storage),
    downloads: new Downloads(session, options.downloadTransport ?? storage),
    shares: new Shares(session),
    jobs: new Jobs(session),
    account: new Profile(session),
    webdav: new WebDAV(session),
  };
}

/** Authenticated resources returned by createClient. @public */
export type CloudreveClient = Awaited<ReturnType<typeof createClient>>;

/** Server and transport dependencies for anonymous share access. @public */
export interface PublicClientOptions {
  downloadTransport?: Transport;
  endpoint: string;
  transport: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Anonymous read-only share access. No token store, refresh, ambient cookies or authenticated mutations. @public */
export function createPublicClient(options: PublicClientOptions) {
  const origin = new URL(options.endpoint);

  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new ApiError(-1, "Invalid public server URL");
  }

  const controller = new AbortController();

  const abort = () => controller.abort(options.signal?.reason);

  options.signal?.addEventListener("abort", abort, { once: true });

  if (options.signal?.aborted) {
    abort();
  }

  const execute = <T>(
    path: string,
    init: RequestOptions = {},
    raw = false,
    consumer?: ResponseConsumer<T>,
  ): Promise<T> => {
    const url = new URL(path, origin.origin);
    const method = (init.method ?? "GET").toUpperCase();

    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/api/v4/") ||
      (!["GET", "HEAD"].includes(method) &&
        !(method === "POST" && url.pathname === "/api/v4/file/url"))
    ) {
      throw new ApiError(-1, "Unsupported public operation");
    }

    const headers = new Headers(init.headers);

    headers.delete("Authorization");
    headers.delete("Cookie");

    return withDeadline(
      (signal) =>
        request<T>(
          options.transport,
          url.toString(),
          {
            ...init,
            headers,
            signal,
            timeoutMs: 0,
            credentials: "omit",
            redirect: "error",
          },
          raw,
          consumer,
        ),
      { ...init, timeoutMs: init.timeoutMs ?? options.timeoutMs },
      controller.signal,
    );
  };

  const scope: RequestScope = {
    endpoint: origin.origin,
    signal: controller.signal,
    request: execute,
    consume: (path, consumer, init) => execute(path, init, false, consumer),
  };

  const files = new Files(scope);
  const shares = new Shares(scope);
  const profile = new Profile(scope);

  const shareUri = (value: string) => {
    try {
      const uri = new CrUri(value);

      if (uri.fs() !== "share" || !uri.id()) {
        throw Error("Not a share");
      }

      return uri.toString();
    } catch (error) {
      throw new ApiError(
        -1,
        "Public file operations require a share URI",
        undefined,
        undefined,
        undefined,
        { kind: "validation", cause: error },
      );
    }
  };

  const shareUris = (values: string[]) => {
    if (!Array.isArray(values) || !values.length) {
      throw new ApiError(-1, "Select share file URIs");
    }

    return values.map(shareUri);
  };

  return {
    files: {
      list: async (uri: string, listOptions?: ListOptions, call?: CallOptions) =>
        files.list(shareUri(uri), listOptions, call),
      listStream: (uri: string, listOptions?: ListOptions, call?: CallOptions) =>
        files.listStream(shareUri(uri), listOptions, call),
      info: async (uri: string, call?: CallOptions) => files.info(shareUri(uri), call),
      urls: async (
        uris: string[],
        download = false,
        entity?: string,
        fresh = false,
        call?: CallOptions,
      ) => files.urls(shareUris(uris), download, entity, fresh, call),
      archiveUrl: async (uris: string[], call?: CallOptions) => {
        const selected = shareUris(uris);
        const normalized = toRequestOptions(call);

        return withDeadline(
          async (signal) => {
            const scoped = { ...normalized, signal, timeoutMs: 0 };

            // Archive sessions defer source access until streaming; validate credentials first.
            const sources: string[] = [];

            for (const uri of selected) {
              const target = new CrUri(uri);

              if (target.isRoot()) {
                const share = await shares.resolve(target.id(), target.password(), scoped);

                if (share.unlocked !== true || share.expired) {
                  throw new ApiError(403, "Share is locked, expired or unavailable");
                }

                // Shared roots are virtual; only their children can be archived.
                for await (const file of files.iterate(uri, {}, signal)) {
                  if (file.type === 1) {
                    throw new ApiError(
                      -1,
                      "Community guest archives omit folder descendants; select individual files instead",
                    );
                  }

                  if (validateName(file.name) !== file.name) {
                    throw new ApiError(-1, "Shared filename cannot be preserved");
                  }

                  sources.push(childUri(uri, file.name));
                }
              } else {
                const file = await files.info(uri, scoped);

                if (file.type === 1) {
                  throw new ApiError(
                    -1,
                    "Community guest archives omit folder descendants; select individual files instead",
                  );
                }

                sources.push(uri);
              }
            }

            return files.archiveUrl([...new Set(sources)], scoped);
          },
          {
            ...normalized,
            timeoutMs: normalized.timeoutMs ?? options.timeoutMs,
          },
          controller.signal,
        );
      },
      viewerUrl: async (uri: string, entity?: string, call?: CallOptions) =>
        files.viewerUrl(shareUri(uri), entity, call),
      thumbnail: async (uri: string, contextHint?: string) =>
        files.thumbnail(shareUri(uri), contextHint),
    },
    shares: {
      resolve: shares.resolve.bind(shares),
      publicList: shares.publicList.bind(shares),
    },
    account: { userInfo: profile.userInfo.bind(profile) },
    downloads: new GuestDownloads(scope, options.downloadTransport ?? options.transport),
    dispose: () => {
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}

/** @public */
export type PublicClient = ReturnType<typeof createPublicClient>;
