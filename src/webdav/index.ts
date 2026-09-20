import { toRequestOptions, type CallOptions } from "../protocol/index.ts";
import type { AccountClient } from "../session/index.ts";
import { ApiError, record, Boolset } from "../protocol/index.ts";

/** @public */
export interface DavAccount {
  id: string;
  created_at: string;
  name: string;
  uri: string;
  password: string;
  options?: string;
}

/** @public */
export interface DavOptions {
  name: string;
  uri: string;
  readonly?: boolean;
  proxy?: boolean;
  disable_sys_files?: boolean;
}

/** @public */
export function davOptions(account: DavAccount): DavOptions {
  const flags = new Boolset(account.options);

  return {
    name: account.name,
    uri: account.uri,
    readonly: flags.enabled(0),
    proxy: flags.enabled(1),
    disable_sys_files: flags.enabled(2),
  };
}

function account(value: unknown): DavAccount {
  const data = record(value);

  for (const key of ["id", "name", "uri", "password"]) {
    if (typeof data[key] !== "string" || !data[key]) {
      throw new ApiError(-1, "Invalid WebDAV account response");
    }
  }

  return data as unknown as DavAccount;
}

/** @public */
export class WebDAV {
  constructor(private client: AccountClient) {}

  async list(
    next?: string,
    optionsOrSignal?: CallOptions,
  ): Promise<{ accounts: DavAccount[]; pagination: { next_token?: string } }> {
    const data = record(
      await this.client.request(
        "/api/v4/devices/dav?page_size=50" +
          (next ? "&next_page_token=" + encodeURIComponent(next) : ""),
        toRequestOptions(optionsOrSignal),
      ),
    );

    const accounts = data.accounts ?? [];

    if (!Array.isArray(accounts)) {
      throw new ApiError(-1, "Invalid WebDAV account list");
    }

    return {
      accounts: accounts.map(account),
      pagination: data.pagination ? record(data.pagination) : {},
    };
  }

  async get(id: string, optionsOrSignal?: CallOptions): Promise<DavAccount> {
    let next: string | undefined;
    const seen = new Set<string>();

    do {
      const page = await this.list(next, optionsOrSignal);
      const found = page.accounts.find((account) => account.id === id);

      if (found) {
        return found;
      }

      next = page.pagination.next_token;

      if (next && seen.has(next)) {
        throw new ApiError(-1, "Invalid server pagination");
      }

      if (next) {
        seen.add(next);
      }
    } while (next);

    throw new ApiError(404, "WebDAV account no longer exists");
  }

  async save(
    options: DavOptions,
    id?: string,
    operationOptions?: CallOptions,
  ): Promise<DavAccount> {
    const uri = new URL(options.uri);

    if (
      !options.name.trim() ||
      options.name.length > 255 ||
      uri.protocol !== "cloudreve:" ||
      !["my", "share"].includes(uri.hostname) ||
      uri.search
    ) {
      throw new ApiError(-1, "Enter a name and select a WebDAV root folder");
    }

    return account(
      await this.client.request("/api/v4/devices/dav" + (id ? "/" + encodeURIComponent(id) : ""), {
        ...toRequestOptions(operationOptions),
        retry: "never",
        method: id ? "PATCH" : "PUT",
        body: JSON.stringify({ ...options, name: options.name.trim() }),
      }),
    );
  }

  async revoke(id: string, operationOptions?: CallOptions): Promise<void> {
    await this.client.request("/api/v4/devices/dav/" + encodeURIComponent(id), {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
    });
  }
}
