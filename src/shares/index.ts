import { toRequestOptions, withDeadline, type CallOptions } from "../protocol/index.ts";
import { childUri } from "../files/index.ts";
import type { RequestScope } from "../protocol/index.ts";
import { ApiError, record } from "../protocol/index.ts";

/** @public */
export interface Share {
  id: string;
  name?: string;
  remain_downloads?: number;
  visited: number;
  downloaded?: number;
  price?: number;
  expires?: string;
  unlocked: boolean;
  password_protected?: boolean;
  source_type?: number;
  owner: { id: string; nickname: string; created_at: string };
  created_at?: string;
  expired: boolean;
  permissions?: string;
  url: string;
  show_readme?: boolean;
  size?: number;
  source_uri?: string;
  is_private?: boolean;
  password?: string;
  share_view?: boolean;
}

/** @public */
export interface ShareOptions {
  uri: string;
  downloads?: number;

  /** Creation choice; updates may only preserve the existing protection. */
  is_private?: boolean;

  /** Creation password; Community cannot rotate an existing link password. */
  password?: string;
  expire?: number;
  share_view?: boolean;
  show_readme?: boolean;
}

/** @public */
export interface SharePage {
  shares: Share[];
  pagination: {
    page: number;
    page_size: number;
    total_items?: number;
    next_token?: string;
  };
}

/** @public */
export function shareLink(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(-1, "Invalid share link");
  }

  const url = new URL(value);

  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(-1, "Invalid share link");
  }

  return url.toString();
}

function share(value: unknown): Share {
  const data = record(value);

  if (typeof data.id !== "string" || !data.id || typeof data.visited !== "number") {
    throw new ApiError(-1, "Invalid share response");
  }

  shareLink(data.url);

  if (
    data.expires != null &&
    (typeof data.expires !== "string" || !Number.isFinite(Date.parse(data.expires)))
  ) {
    throw new ApiError(-1, "Invalid share expiry");
  }

  return { ...data, expires: data.expires ?? undefined } as unknown as Share;
}

/** Create and manage shares belonging to the authenticated account. @public */
export class Shares {
  constructor(private client: RequestScope) {}

  async list(
    options: {
      next_page_token?: string;
      order_direction?: string;
      page_size?: number;
    } = {},
    optionsOrSignal?: CallOptions,
  ): Promise<SharePage> {
    const params = new URLSearchParams({
      order_by: "created_at",
      page_size: "50",
      order_direction: "desc",
    });

    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }

    const data = record(
      await this.client.request("/api/v4/share?" + params, toRequestOptions(optionsOrSignal)),
    );

    const items = data.shares ?? [];

    if (!Array.isArray(items)) {
      throw new ApiError(-1, "Invalid share list");
    }

    return {
      shares: items.map(share),
      pagination: record(data.pagination) as unknown as SharePage["pagination"],
    };
  }

  async revokeMany(ids: string[], options?: CallOptions): Promise<void> {
    if (!ids.length || ids.some((id) => typeof id !== "string" || !id)) {
      throw new ApiError(-1, "Select share IDs");
    }

    await this.client.request("/api/v4/share", {
      ...toRequestOptions(options),
      method: "DELETE",
      retry: "never",
      body: JSON.stringify({ ids }),
    });
  }

  async publicList(
    userId: string,
    options: {
      page_size?: number;
      order_by?: string;
      order_direction?: string;
      next_page_token?: string;
    } = {},
    operationOptions?: CallOptions,
  ): Promise<SharePage> {
    if (!userId) {
      throw new ApiError(-1, "Invalid user ID");
    }

    const params = new URLSearchParams({
      page_size: "50",
      order_by: "created_at",
      order_direction: "desc",
    });

    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }

    const data = record(
      await this.client.request(
        `/api/v4/user/shares/${encodeURIComponent(userId)}?${params}`,
        toRequestOptions(operationOptions),
      ),
    );

    const items = data.shares ?? [];

    if (!Array.isArray(items)) {
      throw new ApiError(-1, "Invalid public share list");
    }

    return {
      shares: items.map(share),
      pagination: record(data.pagination) as unknown as SharePage["pagination"],
    };
  }

  async resolve(id: string, password?: string, optionsOrSignal?: CallOptions): Promise<Share> {
    const query = new URLSearchParams();

    if (password) {
      query.set("password", password);
    }

    return share(
      await this.client.request(
        `/api/v4/share/info/${encodeURIComponent(id)}${password ? "?" + query : ""}`,
        toRequestOptions(optionsOrSignal),
      ),
    );
  }

  async info(id: string, optionsOrSignal?: CallOptions): Promise<Share> {
    const path = `/api/v4/share/info/${encodeURIComponent(id)}`;
    const summary = share(await this.client.request(path, toRequestOptions(optionsOrSignal)));
    const query = new URLSearchParams({ owner_extended: "true" });

    // The backend requires the share password when resolving its source, even for its owner.
    if (summary.password) {
      query.set("password", summary.password);
    }

    return share(await this.client.request(path + "?" + query, toRequestOptions(optionsOrSignal)));
  }

  async save(options: ShareOptions, id?: string, operationOptions?: CallOptions): Promise<string> {
    const uri = new URL(options.uri);

    if (uri.protocol !== "cloudreve:" || uri.hostname !== "my" || uri.search) {
      throw new ApiError(-1, "Choose one of your files or folders to share");
    }

    if (options.password && !/^[a-zA-Z0-9]{1,32}$/.test(options.password)) {
      throw new ApiError(-1, "Use up to 32 letters or numbers for the share password");
    }

    for (const number of [options.expire, options.downloads]) {
      if (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) {
        throw new ApiError(-1, "Expiration and download limits must be whole positive numbers");
      }
    }

    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nested = { ...normalized, signal, timeoutMs: 0 };

        if (id && (options.is_private !== undefined || options.password !== undefined)) {
          const current = await this.info(id, nested);

          const privateLink =
            current.is_private ?? current.password_protected ?? !!current.password;

          if (
            (options.is_private !== undefined && options.is_private !== privateLink) ||
            (options.password !== undefined && options.password !== (current.password ?? ""))
          ) {
            throw new ApiError(
              -1,
              "Community cannot change existing share privacy or passwords; create and revoke links explicitly",
            );
          }
        }

        return shareLink(
          await this.client.request("/api/v4/share" + (id ? "/" + encodeURIComponent(id) : ""), {
            ...nested,
            retry: "never",
            method: id ? "POST" : "PUT",
            body: JSON.stringify(options),
          }),
        );
      },
      normalized,
      this.client.signal,
    );
  }

  async revoke(id: string, operationOptions?: CallOptions): Promise<void> {
    await this.client.request("/api/v4/share/" + encodeURIComponent(id), {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
    });
  }

  async directAllowed(): Promise<boolean> {
    const config = record(await this.client.request("/api/v4/site/config/basic"));
    const group = record(record(config.user).group);

    return typeof group.direct_link_batch_size === "number" && group.direct_link_batch_size > 0;
  }

  async direct(
    uri: string,
    operationOptions?: CallOptions,
  ): Promise<{ file_url: string; link: string }[]> {
    const data = await this.client.request<unknown>("/api/v4/file/source", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "PUT",
      body: JSON.stringify({ uris: [uri] }),
    });

    if (!Array.isArray(data)) {
      throw new ApiError(-1, "Invalid direct-link response");
    }

    return data.map((value) => {
      const row = record(value);

      return {
        file_url: String(row.file_url ?? ""),
        link: shareLink(row.link),
      };
    });
  }

  async revokeDirect(id: string, operationOptions?: CallOptions): Promise<void> {
    await this.client.request("/api/v4/file/source/" + encodeURIComponent(id), {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
    });
  }
}

/** Single-file shares expose their parent as source_uri; folders expose themselves. */
/** @public */
export function shareSourceUri(value: Share): string {
  if (!value.source_uri) {
    throw new ApiError(-1, "Share source is unavailable");
  }

  return value.source_type === 0 ? childUri(value.source_uri, value.name ?? "") : value.source_uri;
}

/** Parse a server short share URL without persisting its optional password. @public */
export function parseShareLink(input: string, endpoint: string): { id: string; password?: string } {
  const url = new URL(input);
  const origin = new URL(endpoint);

  const parts = url.pathname.split("/");

  if (
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash ||
    parts[1] !== "s" ||
    !parts[2] ||
    parts.length > 4 ||
    parts.length < 3 ||
    url.search
  ) {
    throw new ApiError(-1, "Invalid share link for this server");
  }

  try {
    return {
      id: decodeURIComponent(parts[2]),
      ...(parts[3] ? { password: decodeURIComponent(parts[3]) } : {}),
    };
  } catch (error) {
    throw new ApiError(-1, "Invalid share link encoding", undefined, undefined, undefined, {
      kind: "validation",
      cause: error,
    });
  }
}

/** Validate a same-server public direct-link route; byte IO and redirects remain platform-owned. @public */
export function validateDirectLink(input: string, endpoint: string): string {
  try {
    const url = new URL(shareLink(input));
    const server = new URL(shareLink(endpoint));
    const parts = url.pathname.split("/");

    const download = parts.length === 5 && parts[1] === "f" && parts[2] === "d";
    const direct = parts.length === 4 && parts[1] === "f";

    if (url.origin !== server.origin || url.hash || (!download && !direct)) {
      throw Error("Invalid route");
    }

    const index = download ? 3 : 2;
    const id = decodeURIComponent(parts[index]!);
    const name = decodeURIComponent(parts[index + 1]!);

    if (
      [id, name].some(
        (part) => !part || part.includes("/") || part.includes(String.fromCharCode(0)),
      )
    ) {
      throw Error("Invalid direct-link target");
    }

    return url.toString();
  } catch (error) {
    throw new ApiError(-1, "Invalid direct link for this server", undefined, undefined, undefined, {
      kind: "validation",
      cause: error,
    });
  }
}
