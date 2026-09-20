import type { CustomProperty } from "./properties.ts";

export {
  customPropertyPatch,
  iconMetadataKeys,
  backupMetadataKeys,
  mediaMetadataKeys,
  EntityType,
  type CustomProperty,
} from "./properties.ts";

import { ViewerGroupsSchema, type Viewer } from "./contracts.ts";
import { readSSE, streamValues, responseData } from "../protocol/index.ts";

/** @public */
export type DirectoryStreamEvent =
  { type: "file"; files: FileEntry[] } | { type: "list"; directory: Directory };

/** @public */
export type ExplorerEvent =
  | { type: "subscribed" | "resumed" | "keep-alive" }
  | { type: "event"; data: Record<string, unknown> };

import { decode, nonempty, natural } from "../protocol/index.ts";
import {
  ExplorerViewSchema,
  FullTextResultsSchema,
  ViewerRequestSchema,
  ViewerSessionSchema,
  type ExplorerView,
  type FullTextResults,
  type ViewerRequest,
  type ViewerSession,
} from "./contracts.ts";

export type { ExplorerView, FullTextResults, ViewerRequest, ViewerSession } from "./contracts.ts";

import { toRequestOptions, withDeadline, type CallOptions } from "../protocol/index.ts";
import { decodeFile, decodeDirectory } from "./schemas.ts";
import { CrUri } from "./uri.ts";
import type { RequestScope } from "../protocol/index.ts";
import { ApiError, record, Boolset, assertNotAborted, type Transport } from "../protocol/index.ts";

/** @public */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** @public */
export interface TextDocument {
  uri: string;
  name: string;
  entity: string;
  text: string;
  bom: boolean;
  lineEnding: "\n" | "\r\n";
}

/** @public */
export interface FileEntry {
  id: string;
  name: string;
  path: string;
  type: number;
  size: number;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, string>;
  capability?: string;
  owned?: boolean;
  shared?: boolean;
  permission?: string;
  primary_entity?: string;
  folder_summary?: {
    size: number;
    files: number;
    folders: number;
    completed: boolean;
    calculated_at: string;
  };
  extended_info?: {
    storage_used: number;
    entities?: { id: string; type: number; size: number; created_at: string }[];
    direct_links?: { id: string; url: string; downloaded: number }[];
  };
}

/** @public */
export interface StoragePolicy {
  id: string;
  name?: string;
  type?: string;
  max_size?: number;
  weight?: number;
  children?: StoragePolicy[];
}

/** @public */
export interface Directory {
  view?: ExplorerView;
  files: FileEntry[];
  pagination: {
    page: number;
    page_size: number;
    total_items?: number;
    next_token?: string;
    is_cursor?: boolean;
  };
  props: {
    capability?: string;
    max_page_size: number;
    order_by_options: string[];
    order_direction_options: string[];
  };
  parent?: FileEntry;
  context_hint?: string;
  storage_policy?: StoragePolicy;
}

/** @public */
export interface ListOptions {
  page?: number;
  page_size?: number;
  next_page_token?: string;
  order_by?: string;
  order_direction?: string;
}

/** @public */
export function validateName(name: string): string {
  const value = name.trim();

  // eslint-disable-next-line no-control-regex -- Filename input must reject control bytes.
  if (!value || value === "." || value === ".." || /[\x00-\x1f/\\]/.test(value)) {
    throw new ApiError(-1, "Enter a valid file name");
  }

  return value;
}

/** @public */
export function childUri(parent: string, name: string): string {
  const url = new URL(parent);

  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(validateName(name))}`;
  url.search = "";

  return url.toString();
}

/** @public */
export function fileEntry(value: unknown): FileEntry {
  return decodeFile(value) as FileEntry;
}

/** Account file operations using Cloudreve URIs and server-enforced permissions. @public */
export class Files {
  listStream(
    uri: string,
    listOptions: ListOptions = {},
    options?: CallOptions,
  ): AsyncGenerator<DirectoryStreamEvent> {
    new CrUri(uri).assertValidSearch();

    const normalized = toRequestOptions(options);
    const params = new URLSearchParams({ uri });

    for (const [key, value] of Object.entries(listOptions)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }

    return streamValues(
      (emit, signal) =>
        this.client.consume<void>(
          `/api/v4/file?${params}`,
          async (response, lifetime) => {
            if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
              const data = decodeDirectory(await responseData(response, lifetime));

              await emit({
                type: "list",
                directory: {
                  ...data,
                  files: data.files ?? [],
                } as unknown as Directory,
              });

              return;
            }

            let terminal = false;

            for await (const frame of readSSE(response, lifetime)) {
              const value = this.streamJSON(frame.data);

              if (frame.event === "file") {
                if (terminal || !Array.isArray(value)) {
                  throw new ApiError(-1, "Invalid directory stream batch");
                }

                await emit({ type: "file", files: value.map(fileEntry) });
              } else if (frame.event === "list") {
                if (terminal) {
                  throw new ApiError(-1, "Duplicate directory stream result");
                }

                const data = decodeDirectory(value);

                terminal = true;

                await emit({
                  type: "list",
                  directory: {
                    ...data,
                    files: data.files ?? [],
                  } as unknown as Directory,
                });
              } else {
                throw new ApiError(-1, "Unexpected directory stream event");
              }
            }

            if (!terminal) {
              throw new ApiError(-1, "Directory stream ended without result");
            }
          },
          {
            ...normalized,
            signal,
            headers: {
              ...Object.fromEntries(new Headers(normalized.headers)),
              Accept: "text/event-stream",
            },
          },
        ),
      normalized.signal,
    );
  }

  events(uri: string, clientId: string, options?: CallOptions): AsyncGenerator<ExplorerEvent> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      throw new ApiError(-1, "Event client ID must be a UUID");
    }

    const normalized = toRequestOptions(options);

    return streamValues(
      (emit, signal) =>
        this.client.consume<void>(
          `/api/v4/file/events?${new URLSearchParams({ uri })}`,
          async (response, lifetime) => {
            if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
              await responseData(response, lifetime);

              throw new ApiError(-1, "Expected an event stream");
            }

            for await (const frame of readSSE(response, lifetime)) {
              if (frame.event === "event") {
                await emit({
                  type: "event",
                  data: record(this.streamJSON(frame.data)),
                });
              } else if (["subscribed", "resumed", "keep-alive"].includes(frame.event)) {
                await emit({
                  type: frame.event as "subscribed" | "resumed" | "keep-alive",
                });
              } else {
                throw new ApiError(-1, "Unexpected explorer event");
              }
            }
          },
          {
            ...normalized,
            timeoutMs: normalized.timeoutMs ?? 0,
            signal,
            headers: {
              ...Object.fromEntries(new Headers(normalized.headers)),
              Accept: "text/event-stream",
              "X-Cr-Client-Id": clientId,
            },
          },
        ),
      normalized.signal,
    );
  }

  private streamJSON(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new ApiError(-1, "Invalid server event JSON", undefined, undefined, undefined, {
        kind: "validation",
        cause: error,
      });
    }
  }

  async promoteVersion(uri: string, version: string, options?: CallOptions): Promise<void> {
    await this.mutate(
      "version/current",
      "POST",
      {
        uri: decode(nonempty, uri, "Invalid URI"),
        version: decode(nonempty, version, "Invalid version"),
      },
      options,
    );
  }

  async deleteVersion(uri: string, version: string, options?: CallOptions): Promise<void> {
    await this.mutate(
      "version",
      "DELETE",
      {
        uri: decode(nonempty, uri, "Invalid URI"),
        version: decode(nonempty, version, "Invalid version"),
      },
      options,
    );
  }

  async pin(uri: string, name = "", options?: CallOptions): Promise<void> {
    await this.mutate("pin", "PUT", { uri: decode(nonempty, uri, "Invalid URI"), name }, options);
  }

  async unpin(uri: string, options?: CallOptions): Promise<void> {
    await this.mutate("pin", "DELETE", { uri: decode(nonempty, uri, "Invalid URI") }, options);
  }

  async patchView(uri: string, view: ExplorerView | null, options?: CallOptions): Promise<void> {
    await this.mutate(
      "view",
      "PATCH",
      {
        uri: decode(nonempty, uri, "Invalid URI"),
        view: view === null ? null : decode(ExplorerViewSchema, view, "Invalid explorer view"),
      },
      options,
    );
  }

  async viewers(options?: CallOptions): Promise<Viewer[]> {
    const config = record(
      await this.client.request("/api/v4/site/config/explorer", toRequestOptions(options)),
    );

    return decode(ViewerGroupsSchema, config.file_viewers, "Invalid viewer configuration").flatMap(
      (group) => group.viewers,
    );
  }

  async viewerSession(input: ViewerRequest, options?: CallOptions): Promise<ViewerSession> {
    return decode(
      ViewerSessionSchema,
      await this.mutate(
        "viewerSession",
        "PUT",
        decode(ViewerRequestSchema, input, "Invalid viewer request"),
        options,
      ),
      "Invalid viewer session",
    );
  }

  async fullTextSearch(query: string, offset = 0, options?: CallOptions): Promise<FullTextResults> {
    const params = new URLSearchParams({
      query: decode(nonempty, query, "Enter a search query"),
      offset: String(decode(natural, offset, "Invalid search offset")),
    });

    return decode(
      FullTextResultsSchema,
      await this.client.request(`/api/v4/file/search?${params}`, toRequestOptions(options)),
      "Invalid full-text search results",
    );
  }

  private mutate(
    path: string,
    method: string,
    body: unknown,
    options?: CallOptions,
  ): Promise<unknown> {
    return this.client.request(`/api/v4/file/${path}`, {
      ...toRequestOptions(options),
      retry: "never",
      method,
      body: JSON.stringify(body),
    });
  }

  get accountId(): string {
    if (!this.client.accountId) {
      throw new ApiError(-1, "Public shares have no account identity");
    }

    return this.client.accountId;
  }

  constructor(private client: RequestScope & { accountId?: string }) {}

  async readText(
    uri: string,
    storage: Transport,
    entity?: string,
    signal?: AbortSignal,
  ): Promise<TextDocument> {
    const file = await this.info(uri);
    const selected = entity ?? file.primary_entity;

    const version =
      entity && entity !== file.primary_entity
        ? file.extended_info?.entities?.find((e) => e.id === entity)
        : undefined;

    if (file.type !== 0 || !selected || (entity && entity !== file.primary_entity && !version)) {
      throw new ApiError(-1, "File version is unavailable");
    }

    const size = version?.size ?? file.size;

    if (size > MAX_TEXT_BYTES) {
      throw new ApiError(
        -1,
        "This file exceeds the 5 MB text editor limit. Download and open it externally.",
      );
    }

    let bytes = new Uint8Array(0);

    if (size > 0) {
      const [url] = await this.urls([uri], false, selected, true);

      if (!url) {
        throw new ApiError(-1, "Preview URL unavailable");
      }

      assertNotAborted(signal);

      const response = await storage(url, {
        signal,
        credentials: "omit",
        redirect: "error",
      });

      if (!response.ok) {
        await response.body?.cancel();

        throw new ApiError(response.status, "Unable to read this file");
      }

      const reader = response.body?.getReader();

      if (!reader) {
        throw new ApiError(-1, "Text streaming is unavailable");
      }

      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (true) {
          assertNotAborted(signal);

          const next = await reader.read();

          if (next.done) {
            break;
          }

          total += next.value.length;

          if (total > MAX_TEXT_BYTES || total > size) {
            throw new ApiError(-1, "Text content exceeds its expected size");
          }

          chunks.push(next.value);
        }

        if (total !== size) {
          throw new ApiError(-1, "Text download was interrupted");
        }
      } finally {
        await reader.cancel().catch(() => {});
      }

      bytes = new Uint8Array(total);

      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    assertNotAborted(signal);

    if (bytes.includes(0)) {
      throw new ApiError(
        -1,
        "This is a binary or non-UTF-8 file. Download and open it externally.",
      );
    }

    let text: string;

    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApiError(-1, "This file is not valid UTF-8 text. Download and open it externally.");
    }

    return {
      uri: file.path,
      name: file.name,
      entity: selected,
      text,
      bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
      lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    };
  }

  async saveText(
    document: TextDocument,
    text: string,
    operationOptions?: CallOptions,
  ): Promise<FileEntry> {
    if (!document.entity) {
      throw new ApiError(-1, "Reload this document before saving");
    }

    const content = (document.bom ? "\uFEFF" : "") + text;
    const size = new TextEncoder().encode(content).length;

    if (content.includes("\0") || size > MAX_TEXT_BYTES) {
      throw new ApiError(-1, "Only UTF-8 text up to 5 MB can be saved");
    }

    const params = new URLSearchParams({
      uri: document.uri,
      previous: document.entity,
    });

    const result = fileEntry(
      await this.client.request("/api/v4/file/content?" + params, {
        ...toRequestOptions(operationOptions),
        retry: "never",
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
      }),
    );

    if (result.size !== size) {
      throw new ApiError(
        -1,
        "Server did not confirm the saved text size. Your draft has been retained.",
      );
    }

    return result;
  }

  async customProperties(): Promise<CustomProperty[]> {
    const config = record(await this.client.request("/api/v4/site/config/explorer"));

    if (!config.custom_props) {
      return [];
    }

    if (!Array.isArray(config.custom_props)) {
      throw new ApiError(-1, "Invalid custom properties");
    }

    return config.custom_props.map((item) => {
      const property = record(item);

      if (
        typeof property.id !== "string" ||
        typeof property.name !== "string" ||
        typeof property.type !== "string"
      ) {
        throw new ApiError(-1, "Invalid custom property");
      }

      return property as unknown as CustomProperty;
    });
  }

  async list(
    uri: string,
    options: ListOptions = {},
    optionsOrSignal?: CallOptions,
  ): Promise<Directory> {
    const streamed: FileEntry[] = [];

    let directory: Directory | undefined;
    let hasBatches = false;

    for await (const event of this.listStream(uri, options, optionsOrSignal)) {
      if (event.type === "file") {
        hasBatches = true;
        streamed.push(...event.files);
      } else {
        directory = event.directory;
      }
    }

    return { ...directory!, files: hasBatches ? streamed : directory!.files };
  }

  async *iterate(
    uri: string,
    options: ListOptions = {},
    signal?: AbortSignal,
  ): AsyncGenerator<FileEntry> {
    const seen = new Set<string>();
    let current = options;

    while (true) {
      assertNotAborted(signal);

      const page = await this.list(uri, current, signal);

      for (const file of page.files) {
        assertNotAborted(signal);
        yield file;
      }

      const next = nextPage(page.pagination);

      if (!next) {
        return;
      }

      const key = JSON.stringify(next);

      if (seen.has(key)) {
        throw new ApiError(-1, "Invalid server pagination");
      }

      seen.add(key);
      current = { ...options, ...next };
    }
  }

  /** Only known missing-path errors mean absence; permission/conflict errors propagate. */
  async infoIfExists(uri: string, operationOptions?: CallOptions): Promise<FileEntry | undefined> {
    try {
      return await this.info(uri, operationOptions);
    } catch (error) {
      if (error instanceof ApiError && [404, 40016].includes(error.code)) {
        return undefined;
      }

      throw error;
    }
  }

  async resolveDestination(
    name: string,
    destination: string,
    requireDirectory = false,
    operationOptions?: CallOptions,
  ): Promise<{ uri: string; parent: string }> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        validateName(name);

        const requested = new CrUri(destination);

        if (
          requested.fs() !== "my" ||
          requested.id() ||
          requested.password() ||
          new URL(destination).search
        ) {
          throw new ApiError(
            -1,
            "Destination must be a personal directory without query or account overrides",
          );
        }

        const existing = await this.infoIfExists(destination, nestedOptions);

        if (requireDirectory && existing?.type !== 1) {
          throw new ApiError(-1, "Destination directory does not exist");
        }

        const target = existing?.type === 1 ? requested.join(name) : requested;

        if (target.isRoot() || (existing && existing.type !== 1)) {
          throw new ApiError(40004, "Destination exists");
        }

        const parent = target.parent();

        if ((await this.info(parent.toString(), nestedOptions)).type !== 1) {
          throw new ApiError(-1, "Destination parent is not a directory");
        }

        if (await this.infoIfExists(target.toString(), nestedOptions)) {
          throw new ApiError(40004, "Destination exists");
        }

        return { uri: target.toString(), parent: parent.toString() };
      },
      normalized,
      this.client.signal,
    );
  }

  /** ponytail: one backend mutation; cross-directory renaming needs reconciled partial outcomes first. */
  async copyTo(
    source: string,
    destination: string,
    options: {
      copy?: boolean;
      requireDirectory?: boolean;
      recursive?: boolean;
    } = {},
    operationOptions?: CallOptions,
  ): Promise<{ uri: string; operation: "copy" | "move" | "rename" }> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const from = new CrUri(source);

        if (
          from.fs() !== "my" ||
          from.id() ||
          from.password() ||
          from.isRoot() ||
          new URL(source).search
        ) {
          throw new ApiError(-1, "Copy and move require a personal file or folder");
        }

        const file = await this.info(source, nestedOptions);

        if (options.copy && file.type === 1 && !options.recursive) {
          throw new ApiError(-1, "Directory copy requires recursive intent");
        }

        const target = await this.resolveDestination(
          file.name,
          destination,
          options.requireDirectory,
          nestedOptions,
        );

        const to = new CrUri(target.uri);

        if (
          file.type === 1 &&
          (to.path() === from.path() || to.path().startsWith(from.path() + "/"))
        ) {
          throw new ApiError(-1, "Cannot copy or move a directory into itself");
        }

        const name = to.elements().at(-1)!;

        if (!options.copy && from.parent().toString() === target.parent) {
          if (validateName(name) !== name) {
            throw new ApiError(-1, "Rename with outer whitespace is unsupported");
          }

          await this.rename(source, name, nestedOptions);

          return { uri: target.uri, operation: "rename" };
        }

        if (name !== file.name) {
          throw new ApiError(-1, "Cross-directory copy or move must preserve the source name");
        }

        await this.move([source], target.parent, options.copy, nestedOptions);

        return { uri: target.uri, operation: options.copy ? "copy" : "move" };
      },
      normalized,
      this.client.signal,
    );
  }

  async thumbnail(uri: string, contextHint?: string): Promise<{ url: string }> {
    const params = new URLSearchParams({ uri });

    const value = record(
      await this.client.request("/api/v4/file/thumb?" + params, {
        headers: contextHint ? { "X-Cr-Context-Hint": contextHint } : {},
      }),
    );

    if (typeof value.url !== "string" || !value.url) {
      throw new ApiError(-1, "Invalid thumbnail response");
    }

    return value as { url: string };
  }

  async urls(
    uris: string[],
    download = false,
    entity?: string,
    fresh = false,
    options?: CallOptions,
  ): Promise<string[]> {
    return this.fileUrls(
      {
        uris,
        download,
        entity,
        ...(fresh ? { no_cache: true } : {}),
      },
      options,
    );
  }

  async viewerUrl(uri: string, entity?: string, options?: CallOptions): Promise<string> {
    const urls = await this.fileUrls({ uris: [uri], entity, use_primary_site_url: true }, options);

    if (urls.length !== 1) {
      throw new ApiError(-1, "Invalid viewer source URL response");
    }

    return urls[0]!;
  }

  async archiveUrl(uris: string[], options?: CallOptions): Promise<string> {
    if (!uris.length) {
      throw new ApiError(-1, "Select files to archive");
    }

    const urls = await this.fileUrls({ uris, download: true, archive: true }, options);

    if (urls.length !== 1) {
      throw new ApiError(-1, "Invalid archive URL response");
    }

    return urls[0]!;
  }

  private async fileUrls(input: Record<string, unknown>, options?: CallOptions): Promise<string[]> {
    const data = record(
      await this.client.request("/api/v4/file/url", {
        ...toRequestOptions(options),
        retry: "never",
        method: "POST",
        body: JSON.stringify(input),
      }),
    );

    if (!Array.isArray(data.urls)) {
      throw new ApiError(-1, "Invalid file URL response");
    }

    return data.urls.map((item) => {
      const value = record(item);

      if (typeof value.url !== "string") {
        throw new ApiError(-1, "Invalid file URL");
      }

      const url = new URL(value.url, this.client.endpoint);

      if (!["http:", "https:"].includes(url.protocol)) {
        throw new ApiError(-1, "Unsupported file URL");
      }

      return url.toString();
    });
  }

  metadata(
    uris: string[],
    patches: { key: string; value?: string; remove?: boolean }[],
    operationOptions?: CallOptions,
  ): Promise<unknown> {
    return this.client.request("/api/v4/file/metadata", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "PATCH",
      body: JSON.stringify({ uris, patches }),
    });
  }

  unlock(tokens: string[], operationOptions?: CallOptions): Promise<unknown> {
    return this.client.request("/api/v4/file/lock", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
      body: JSON.stringify({ tokens }),
    });
  }

  emptyTrash(operationOptions?: CallOptions): Promise<unknown> {
    return this.client.request("/api/v4/file/trash", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
    });
  }

  async create(
    parent: string,
    name: string,
    type: "file" | "folder",
    operationOptions?: CallOptions,
  ): Promise<FileEntry> {
    return fileEntry(
      await this.client.request("/api/v4/file/create", {
        ...toRequestOptions(operationOptions),
        retry: "never",
        method: "POST",
        body: JSON.stringify({
          uri: childUri(parent, name),
          type,
          err_on_conflict: true,
        }),
      }),
    );
  }

  rename(uri: string, name: string, operationOptions?: CallOptions): Promise<unknown> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        return this.client.request("/api/v4/file/rename", {
          ...toRequestOptions(nestedOptions),
          retry: "never",
          method: "POST",
          body: JSON.stringify({ uri, new_name: validateName(name) }),
        });
      },
      normalized,
      this.client.signal,
    );
  }

  move(
    uris: string[],
    dst: string,
    copy = false,
    operationOptions?: CallOptions,
  ): Promise<unknown> {
    return this.client.request("/api/v4/file/move", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "POST",
      body: JSON.stringify({ uris, dst, copy }),
    });
  }

  async delete(
    uris: string[],
    permanent = false,
    operationOptions?: CallOptions,
  ): Promise<unknown> {
    if (!permanent && uris.some((uri) => new URL(uri).hostname === "trash")) {
      throw new ApiError(-1, "Deleting from trash requires explicit permanent deletion");
    }

    return this.client.request("/api/v4/file", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
      body: JSON.stringify({ uris, skip_soft_delete: permanent }),
    });
  }

  restore(uris: string[], operationOptions?: CallOptions): Promise<unknown> {
    return this.client.request("/api/v4/file/restore", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "POST",
      body: JSON.stringify({ uris }),
    });
  }

  async info(uri: string, options: CallOptions = {}): Promise<FileEntry> {
    const path = new CrUri(uri);

    // Community file/info forbids namespace roots; listing returns their descriptor.
    if (path.fs() === "my" && path.isRoot()) {
      return fileEntry((await this.list(uri, { page_size: 1 }, options)).parent);
    }

    return fileEntry(
      await this.client.request(
        `/api/v4/file/info?uri=${encodeURIComponent(uri)}&extended=true&folder_summary=true`,
        toRequestOptions(options),
      ),
    );
  }
}

export { CrUri, UriSearchCategory } from "./uri.ts";

/** @public */
export type { SearchParams, UriSearchCategoryValue } from "./uri.ts";

/** Community action capabilities, matching the official frontend's ownership rules. */
/** @public */
export function fileActions(file: FileEntry) {
  const cap = new Boolset(file.capability);
  const owned = file.owned === true && new URL(file.path).hostname !== "share";

  return {
    create: owned && file.type === 1 && cap.enabled(0),
    rename: owned && cap.enabled(1),
    copy: owned && !!file.capability,
    move: owned && !!file.capability,
    delete: owned && (cap.enabled(14) || cap.enabled(16)),
    restore: cap.enabled(17),
    metadata: owned && cap.enabled(8),
    edit: owned && file.type === 0 && cap.enabled(6),
    download: cap.enabled(7),
  };
}

/** @public */
export function nextPage(page: Directory["pagination"]): ListOptions | undefined {
  if (page.next_token) {
    return { next_page_token: page.next_token };
  }

  if (
    !page.is_cursor &&
    page.page_size > 0 &&
    page.total_items !== undefined &&
    (page.page + 1) * page.page_size < page.total_items
  ) {
    return { page: page.page + 1 };
  }

  return undefined;
}

/** One metadata request replaces a renamed tag rather than leaving the previous tag behind. */
/** @public */
export function tagPatches(
  name: string,
  color: string,
  original?: string,
  remove = false,
): { key: string; value?: string; remove?: boolean }[] {
  const next = name.trim();
  const previous = original?.trim();

  if (!next || [...next].length > 255) {
    throw new ApiError(-1, "Enter a tag name of 1–255 characters");
  }

  if (remove) {
    return [{ key: `tag:${previous || next}`, remove: true }];
  }

  if (!/^#[\da-f]{6}$/i.test(color)) {
    throw new ApiError(-1, "Use a color such as #007AFF.");
  }

  return [
    ...(previous && previous !== next ? [{ key: `tag:${previous}`, remove: true }] : []),
    { key: `tag:${next}`, value: color },
  ];
}

export * from "./contracts.ts";

export { customViewerUrl, type ViewerVariables } from "./viewer-url.ts";

export {
  validatePlaylist,
  playlistAdd,
  playlistRemove,
  playlistMove,
  type Playlist,
} from "./playlist.ts";

export { lockConflicts, type LockConflict } from "./locks.ts";
