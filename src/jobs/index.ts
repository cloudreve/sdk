import * as v from "valibot";
import { decode, nonempty } from "../protocol/index.ts";
import { toRequestOptions, type CallOptions } from "../protocol/index.ts";
import type { AccountClient } from "../session/index.ts";
import { ApiError, record } from "../protocol/index.ts";
import {
  TaskStatus,
  TaskType,
  ListTaskCategory,
  type TaskResponse,
  type TaskListResponse,
} from "./types.ts";

export * from "./types.ts";

/** @public */
export interface ArchiveOptions {
  src: string[];
  dst: string;
  encoding?: string;
  password?: string;
  file_mask?: string[];
}

/** @public */
export interface ArchivedFile {
  name: string;
  size: number;
  updated_at?: string;
  is_directory: boolean;
}

/** @public */
export const archiveEncodings: readonly string[] = [
  "gb18030",
  "gbk",
  "big5",
  "shiftjis",
  "eucjp",
  "iso2022jp",
  "euckr",
  "ibm866",
  "koi8r",
  "koi8u",
  "macintosh",
  "macintoshcyrillic",
  "windows874",
  ...Array.from({ length: 9 }, (_, i) => "windows" + (1250 + i)),
  ...[2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 15, 16].map((i) => "iso8859_" + i),
  "utf16be",
  "utf16le",
];

function encoding(value?: string): string | undefined {
  const normalized = value?.toLowerCase();

  if (normalized && !archiveEncodings.includes(normalized)) {
    throw new ApiError(-1, "Unsupported ZIP filename encoding");
  }

  return normalized || undefined;
}

function task(value: unknown): TaskResponse {
  const data = record(value);

  if (
    typeof data.id !== "string" ||
    !data.id ||
    typeof data.type !== "string" ||
    !Object.values(TaskStatus).includes(data.status as TaskStatus)
  ) {
    throw new ApiError(-1, "Invalid server task");
  }

  return data as unknown as TaskResponse;
}

/** @public */
export function activeTask(value: TaskResponse): boolean {
  return [TaskStatus.queued, TaskStatus.processing, TaskStatus.suspending].includes(value.status);
}

/** @public */
export function canCancelTask(value: TaskResponse): boolean {
  return (
    value.type === TaskType.remote_download &&
    [TaskStatus.processing, TaskStatus.suspending].includes(value.status)
  );
}

/** @public */
export function canSelectTaskFiles(value: TaskResponse): boolean {
  return (
    canCancelTask(value) &&
    value.summary?.phase === "monitor" &&
    !!value.summary.props.download?.files?.length
  );
}

/** @public */
export class Jobs {
  constructor(private client: AccountClient) {}

  async createDownload(
    input: { src?: string[]; src_file?: string; dst: string },
    options?: CallOptions,
  ): Promise<TaskResponse[]> {
    const body = decode(
      v.pipe(
        v.strictObject({
          src: v.optional(v.pipe(v.array(nonempty), v.minLength(1))),
          src_file: v.optional(nonempty),
          dst: nonempty,
        }),
        v.check((value) => !!value.src !== !!value.src_file),
      ),
      input,
      "Specify URL sources or one torrent file and a destination",
    );

    const value = await this.client.request<unknown>("/api/v4/workflow/download", {
      ...toRequestOptions(options),
      method: "POST",
      retry: "never",
      body: JSON.stringify(body),
    });

    if (!Array.isArray(value)) {
      throw new ApiError(-1, "Invalid download task response");
    }

    return value.map(task);
  }

  async list(
    category: ListTaskCategory,
    next?: string,
    optionsOrSignal?: CallOptions,
  ): Promise<TaskListResponse> {
    const params = new URLSearchParams({ category, page_size: "50" });

    if (next) {
      params.set("next_page_token", next);
    }

    const data = record(
      await this.client.request("/api/v4/workflow?" + params, toRequestOptions(optionsOrSignal)),
    );

    const tasks = data.tasks ?? [];

    if (!Array.isArray(tasks)) {
      throw new ApiError(-1, "Invalid task list");
    }

    return {
      tasks: tasks.map(task),
      pagination: record(data.pagination) as unknown as TaskListResponse["pagination"],
    };
  }

  async get(id: string, type: string, optionsOrSignal?: CallOptions): Promise<TaskResponse> {
    const categories =
      type === TaskType.remote_download
        ? [ListTaskCategory.downloading, ListTaskCategory.downloaded]
        : [ListTaskCategory.general];

    for (const category of categories) {
      let next: string | undefined;
      const seen = new Set<string>();

      do {
        const page = await this.list(category, next, optionsOrSignal);
        const found = page.tasks.find((t) => t.id === id);

        if (found) {
          return found;
        }

        next = page.pagination.next_token;

        if (next && seen.has(next)) {
          throw new ApiError(-1, "Invalid task pagination");
        }

        if (next) {
          seen.add(next);
        }
      } while (next);
    }

    throw new ApiError(404, "Server task no longer exists");
  }

  async archive(
    options: ArchiveOptions,
    extract = false,
    operationOptions?: CallOptions,
  ): Promise<TaskResponse> {
    if (!options.src.length || (extract && options.src.length !== 1)) {
      throw new ApiError(-1, "Select source files");
    }

    for (const value of [...options.src, options.dst]) {
      const uri = new URL(value);

      if (uri.protocol !== "cloudreve:" || !["my", "share"].includes(uri.hostname)) {
        throw new ApiError(-1, "Invalid archive location");
      }
    }

    if (
      extract &&
      options.password &&
      new URL(options.src[0]!).pathname.toLowerCase().endsWith(".zip")
    ) {
      throw new ApiError(
        -1,
        "Password-protected ZIP extraction is unavailable in the server workflow. Download and open this archive with another app.",
      );
    }

    if (options.file_mask?.some((path) => !path || path.split(/[\\/]/).includes(".."))) {
      throw new ApiError(-1, "Unsafe archive path");
    }

    return task(
      await this.client.request("/api/v4/workflow/" + (extract ? "extract" : "archive"), {
        ...toRequestOptions(operationOptions),
        retry: "never",
        method: "POST",
        body: JSON.stringify({
          ...options,
          encoding: encoding(options.encoding),
        }),
      }),
    );
  }

  async archiveFiles(
    uri: string,
    textEncoding?: string,
    optionsOrSignal?: CallOptions,
  ): Promise<ArchivedFile[]> {
    const params = new URLSearchParams({ uri });

    if (textEncoding) {
      params.set("text_encoding", encoding(textEncoding)!);
    }

    const data = record(
      await this.client.request(
        "/api/v4/file/archive?" + params,
        toRequestOptions(optionsOrSignal),
      ),
    );

    const files = data.files ?? [];

    if (!Array.isArray(files)) {
      throw new ApiError(-1, "Invalid archive listing");
    }

    return files.map((value) => {
      const file = record(value);

      if (
        typeof file.name !== "string" ||
        typeof file.size !== "number" ||
        typeof file.is_directory !== "boolean"
      ) {
        throw new ApiError(-1, "Invalid archive entry");
      }

      return file as unknown as ArchivedFile;
    });
  }

  async cancel(value: TaskResponse, operationOptions?: CallOptions): Promise<void> {
    if (!canCancelTask(value)) {
      throw new ApiError(-1, "This task cannot be canceled");
    }

    await this.client.request("/api/v4/workflow/download/" + encodeURIComponent(value.id), {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "DELETE",
    });
  }

  async selectFiles(
    value: TaskResponse,
    selected: number[],
    operationOptions?: CallOptions,
  ): Promise<void> {
    if (!canSelectTaskFiles(value)) {
      throw new ApiError(-1, "Files can only be selected while downloading");
    }

    const files = value.summary!.props.download!.files!;

    if (!selected.length || selected.some((index) => !files.some((file) => file.index === index))) {
      throw new ApiError(-1, "Select at least one download file");
    }

    await this.client.request("/api/v4/workflow/download/" + encodeURIComponent(value.id), {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "PATCH",
      body: JSON.stringify({
        files: files.map((file) => ({
          index: file.index,
          download: selected.includes(file.index),
        })),
      }),
    });
  }
}
