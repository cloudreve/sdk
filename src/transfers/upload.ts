import { UploadSpecSchema } from "./schemas.ts";
import { withDeadline, type RequestOptions } from "../protocol/index.ts";
import { UploadSessionSchema, uploadProviderValues } from "./schemas.ts";
import { decode } from "../protocol/index.ts";
import {
  assertNotAborted,
  ApiError,
  record,
  request,
  type TransportResponse,
  type Transport,
} from "../protocol/index.ts";
import type { AccountClient } from "../session/index.ts";
import type { StoragePolicy } from "../files/index.ts";

/** @public */
export const uploadProviders = uploadProviderValues;

/** @public */
export type UploadProvider = (typeof uploadProviders)[number];

/** Choose once before staging; the persisted leaf policy owns every retry. */
/** @public */
export function selectUploadPolicy(
  policy: StoragePolicy,
  random = Math.random,
): StoragePolicy & { type: UploadProvider } {
  if (policy.type === "load_balance") {
    const children =
      policy.children?.filter((child) => typeof child.weight === "number" && child.weight > 0) ??
      [];

    const total = children.reduce((sum, child) => sum + child.weight!, 0);

    if (!total || !Number.isFinite(total)) {
      invalid("No available upload policies");
    }

    let point = random();

    if (!Number.isFinite(point) || point < 0 || point >= 1) {
      invalid("Invalid policy selection");
    }

    point *= total;

    policy =
      children.find((child) => (point -= child.weight!) < 0) ?? children[children.length - 1]!;
  }

  if (
    typeof policy.id !== "string" ||
    !policy.id ||
    !uploadProviders.includes(policy.type as UploadProvider)
  ) {
    invalid("Unsupported upload provider policy");
  }

  return { ...policy, type: policy.type as UploadProvider };
}

/** @public */
export interface EncryptionMetadata {
  algorithm: "aes-256-ctr";
  key_plain_text: string;
  iv: string;
}

/** @public */
export interface UploadSession {
  session_id: string;
  uri: string;
  expires: number;
  chunk_size: number;
  upload_urls: string[];
  credential: string;
  completeURL: string;
  callback_secret: string;
  encrypt_metadata?: EncryptionMetadata;
  upload_policy?: string;
  mime_type?: string;
  relay?: boolean;
  provider?: UploadProvider;
}

/** @public */
export interface UploadSpec {
  entity_type?: "version" | "live_photo";
  previous?: string;
  metadata?: Record<string, string>;
  uri: string;
  size: number;
  policy_id: string;
  mime_type?: string;
  last_modified?: number;
  encryption_supported?: ["aes-256-ctr"];
}

/** Persist only acknowledgements, never optimistic progress. Treat this record as secret. */
/** @public */
export interface UploadCheckpoint {
  accountId: string;
  endpoint: string;
  spec: UploadSpec;
  provider: UploadProvider;
  session: UploadSession;
  parts: string[];
  completed: boolean;
}

/** @public */
export interface UploadSource {
  size: number;
  chunk(
    start: number,
    end: number,
    encryption: EncryptionMetadata | undefined,
    progress: (loaded: number) => void,
    signal?: AbortSignal,
  ): Promise<{
    body: BodyInit;
    multipart?(fields: Record<string, string>, filename: string, mimeType?: string): BodyInit;
    dispose(): Promise<void>;
  }>;
}

function invalid(message: string): never {
  throw new ApiError(-1, message);
}

function url(value: string): string {
  const parsed = new URL(value);

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    invalid("Invalid storage URL");
  }

  return parsed.toString();
}

function required(value: unknown): string {
  if (typeof value !== "string" || !value) {
    invalid("Invalid upload session");
  }

  return value;
}

/** @public */
export function parseUploadSession(value: unknown): UploadSession {
  const data = decode(UploadSessionSchema, value, "Invalid upload session or upload URLs");
  const links = data.upload_urls;
  let encryption: EncryptionMetadata | undefined;

  if (data.encrypt_metadata) {
    const encrypted = record(data.encrypt_metadata);

    if (encrypted.algorithm !== "aes-256-ctr") {
      invalid("Unsupported upload encryption");
    }

    encryption = {
      algorithm: "aes-256-ctr",
      key_plain_text: required(encrypted.key_plain_text),
      iv: required(encrypted.iv),
    };

    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(encryption.key_plain_text) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(encryption.iv)
    ) {
      invalid("Invalid encryption material");
    }
  }

  const policy = data.storage_policy ? record(data.storage_policy) : undefined;

  if (policy?.type !== undefined && !uploadProviders.includes(policy.type as UploadProvider)) {
    invalid("Unsupported upload provider");
  }

  return {
    session_id: required(data.session_id),
    uri: required(data.uri),
    expires: data.expires,
    chunk_size: Number(data.chunk_size),
    upload_urls: links.map((v) => url(required(v))),
    credential: typeof data.credential === "string" ? data.credential : "",
    completeURL:
      typeof data.completeURL === "string" && data.completeURL ? url(data.completeURL) : "",
    callback_secret: typeof data.callback_secret === "string" ? data.callback_secret : "",
    encrypt_metadata: encryption,
    upload_policy: typeof data.upload_policy === "string" ? data.upload_policy : undefined,
    mime_type: typeof data.mime_type === "string" ? data.mime_type : undefined,
    relay: policy?.relay === true,
    provider: policy?.type as UploadProvider | undefined,
  };
}

const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

/** Cloudreve protocol only. Source and transport own streaming and platform progress. */
/** Resumable uploads through a caller-supplied byte transport. @public */
export class Uploads {
  constructor(
    private client: AccountClient,
    private storage: Transport,
  ) {}

  async create(
    spec: UploadSpec,
    provider: UploadProvider,
    signal?: AbortSignal,
  ): Promise<UploadCheckpoint> {
    spec = decode(UploadSpecSchema, spec, "Invalid upload request");

    if (!uploadProviders.includes(provider)) {
      invalid("Unsupported upload provider");
    }

    if (
      !Number.isSafeInteger(spec.size) ||
      spec.size < 0 ||
      !spec.policy_id ||
      !spec.uri.startsWith("cloudreve://")
    ) {
      invalid("Invalid upload request");
    }

    if (provider === "onedrive" && spec.size === 0) {
      invalid("OneDrive does not support empty files");
    }

    const requestSpec: UploadSpec = {
      entity_type: spec.entity_type,
      previous: spec.previous,
      metadata: spec.metadata,
      uri: spec.uri,
      size: spec.size,
      policy_id: spec.policy_id,
      mime_type: spec.mime_type,
      last_modified: spec.last_modified,
      encryption_supported: spec.encryption_supported,
    };

    const session = parseUploadSession(
      await this.client.request("/api/v4/file/upload", {
        method: "PUT",
        body: JSON.stringify(requestSpec),
        signal,
      }),
    );

    return {
      accountId: this.client.accountId,
      endpoint: this.client.endpoint,
      spec: requestSpec,
      provider: session.relay ? "local" : (session.provider ?? provider),
      session,
      parts: [],
      completed: false,
    };
  }

  private check(job: UploadCheckpoint) {
    if (job.accountId !== this.client.accountId || job.endpoint !== this.client.endpoint) {
      invalid("Upload belongs to another account");
    }
  }

  async cancel(job: UploadCheckpoint, signal?: AbortSignal): Promise<void> {
    this.check(job);

    try {
      await this.client.request("/api/v4/file/upload", {
        method: "DELETE",
        body: JSON.stringify({
          id: job.session.session_id,
          uri: job.session.uri,
        }),
        signal,
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 40016)) {
        throw error;
      }
    }
  }

  async run(
    job: UploadCheckpoint,
    source: UploadSource,
    save: (next: UploadCheckpoint) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
    options: Pick<RequestOptions, "timeoutMs"> = {},
  ): Promise<UploadCheckpoint> {
    if (options.timeoutMs === undefined || options.timeoutMs === 0) {
      return this.runScoped(job, source, save, progress, signal);
    }

    return withDeadline(
      (combined) => this.runScoped(job, source, save, progress, combined),
      { signal, timeoutMs: options.timeoutMs ?? 0 },
      this.client.signal,
    );
  }

  private async runScoped(
    job: UploadCheckpoint,
    source: UploadSource,
    save: (next: UploadCheckpoint) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<UploadCheckpoint> {
    this.check(job);

    const combined = new AbortController();

    const abort = () => combined.abort();

    signal.addEventListener("abort", abort, { once: true });
    this.client.signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted || this.client.signal.aborted) {
      abort();
    }

    try {
      let current = job;

      const remember = async (next: UploadCheckpoint) => {
        await save(next);
        current = next;
      };

      try {
        return await this.runActive(current, source, remember, progress, combined.signal);
      } catch (error) {
        assertNotAborted(combined.signal);

        if (!(error instanceof ApiError && error.code === 40011)) {
          throw error;
        }

        // Cancel only the matching session entity. A concurrent replacement is never overwritten.
        await this.cancel(current, combined.signal);
        assertNotAborted(combined.signal);

        const replacement = await this.create(current.spec, current.provider, combined.signal);

        try {
          await remember(replacement);
        } catch (error) {
          await this.cancel(replacement);

          throw error;
        }

        progress(0);

        // One renewal per run; persistent server failures remain visible instead of looping.
        return await this.runActive(replacement, source, remember, progress, combined.signal);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.client.signal.removeEventListener("abort", abort);
    }
  }

  private async runActive(
    job: UploadCheckpoint,
    source: UploadSource,
    save: (next: UploadCheckpoint) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<UploadCheckpoint> {
    assertNotAborted(signal);

    if (source.size !== job.spec.size) {
      invalid("Upload source changed");
    }

    if (job.completed) {
      return job;
    }

    if (job.session.expires * 1000 <= Date.now()) {
      throw new ApiError(40011, "Upload session expired; restart the upload");
    }

    const size =
      job.provider === "upyun"
        ? Math.max(1, source.size)
        : job.session.chunk_size || Math.max(1, source.size);

    const count = Math.max(1, Math.ceil(source.size / size));

    if (job.parts.length > count) {
      invalid("Invalid upload checkpoint");
    }

    let current = { ...job, parts: [...job.parts] };
    let expected = current.parts.length * size;

    if (job.provider === "onedrive" && current.parts.length < count) {
      expected = await this.oneDriveOffset(job, expected, signal);
    }

    // ponytail: serial chunks bound memory and preserve ordered checkpoints; parallelize only after measurement.
    for (let index = current.parts.length; index < count; index++) {
      assertNotAborted(signal);

      const end = Math.min((index + 1) * size, source.size);
      let start = job.provider === "onedrive" ? Math.max(index * size, expected) : index * size;
      let etag = "";

      for (let attempt = 0; ; attempt++) {
        if (job.provider === "onedrive" && start >= end) {
          break;
        }

        const chunk = await source.chunk(
          start,
          end,
          job.session.encrypt_metadata,
          (loaded) => progress(start + Math.min(end - start, Math.max(0, loaded))),
          signal,
        );

        try {
          assertNotAborted(signal);

          let body = chunk.body;

          if (job.provider === "upyun") {
            if (!chunk.multipart) {
              invalid("Multipart upload is unavailable on this platform");
            }

            const fields: Record<string, string> = {
              policy: required(job.session.upload_policy),
              authorization: required(job.session.credential),
            };

            const mime = job.session.mime_type ?? job.spec.mime_type;

            if (mime) {
              fields["content-type"] = mime;
            }

            body = chunk.multipart(
              fields,
              decodeURIComponent(new URL(job.spec.uri).pathname.split("/").pop() || "upload"),
              mime,
            );
          }

          etag = await this.part(current, index, body, signal, start, end);
          assertNotAborted(signal);
          break;
        } catch (error) {
          if (
            job.provider !== "onedrive" ||
            attempt !== 0 ||
            !(error instanceof ApiError) ||
            error.code !== 416
          ) {
            throw error;
          }

          const body = record(error.data);
          const detail = record(body.error);

          const inner = detail.innererror ? record(detail.innererror) : undefined;

          if (detail.code !== "fragmentOverlap" && inner?.code !== "fragmentOverlap") {
            throw error;
          }

          expected = await this.oneDriveOffset(job, start + 1, signal);
          start = expected;
        } finally {
          await chunk.dispose();
        }
      }

      current = { ...current, parts: [...current.parts, etag] };
      await save(current);
      progress(end);
    }

    assertNotAborted(signal);
    await this.finish(current, signal);
    assertNotAborted(signal);
    current = { ...current, completed: true };
    await save(current);

    return current;
  }

  private async oneDrive(job: UploadCheckpoint, init: RequestInit): Promise<TransportResponse> {
    try {
      return await this.external(required(job.session.upload_urls[0]), init);
    } catch (error) {
      if (error instanceof ApiError && error.code === 404) {
        throw new ApiError(40011, "OneDrive upload session expired");
      }

      throw error;
    }
  }

  private async oneDriveOffset(
    job: UploadCheckpoint,
    minimum: number,
    signal: AbortSignal,
  ): Promise<number> {
    const response = await this.oneDrive(job, { method: "GET", signal });
    const ranges = record(await response.json()).nextExpectedRanges;

    if (
      !Array.isArray(ranges) ||
      ranges.length !== 1 ||
      typeof ranges[0] !== "string" ||
      !/^\d+-\d*$/.test(ranges[0])
    ) {
      invalid("Invalid OneDrive resume range");
    }

    const [start, end] = ranges[0].split("-");
    const offset = Number(start);

    if (
      !Number.isSafeInteger(offset) ||
      offset < minimum ||
      offset > job.spec.size ||
      (end !== "" &&
        (!Number.isSafeInteger(Number(end)) ||
          Number(end) < offset ||
          Number(end) >= job.spec.size))
    ) {
      invalid("OneDrive progress differs from the saved upload; restart required");
    }

    return offset;
  }

  private async external(destination: string, init: RequestInit): Promise<TransportResponse> {
    const response = await this.storage(url(destination), {
      ...init,
      redirect: "error",
      credentials: "omit",
    });

    if (!response.ok) {
      throw new ApiError(
        response.status,
        `Storage request failed (${response.status})`,
        undefined,
        await response.json().catch(() => undefined),
      );
    }

    return response;
  }

  private async part(
    job: UploadCheckpoint,
    index: number,
    body: BodyInit,
    signal: AbortSignal,
    start: number,
    end: number,
  ): Promise<string> {
    const session = job.session;
    const headers = { "Content-Type": "application/octet-stream" };

    if (job.provider === "upyun") {
      await this.external(required(session.upload_urls[0]), {
        method: "POST",
        body,
        signal,
      });

      return "";
    }

    if (job.provider === "onedrive") {
      await this.oneDrive(job, {
        method: "PUT",
        body,
        signal,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end - 1}/${job.spec.size}`,
        },
      });

      return "";
    }

    if (job.provider === "local") {
      await this.client.request(
        `/api/v4/file/upload/${encodeURIComponent(session.session_id)}/${index}`,
        { method: "POST", headers, body, signal },
      );

      return "";
    }

    if (job.provider === "remote") {
      const destination = new URL(required(session.upload_urls[0]));

      destination.searchParams.set("chunk", String(index));

      await request(this.storage, destination.toString(), {
        method: "POST",
        headers: { ...headers, Authorization: required(session.credential) },
        body,
        signal,
        redirect: "error",
        credentials: "omit",
      });

      return "";
    }

    if (job.provider === "qiniu") {
      const response = await this.external(`${required(session.upload_urls[0])}/${index + 1}`, {
        method: "PUT",
        headers: {
          ...headers,
          Authorization: `UpToken ${required(session.credential)}`,
        },
        body,
        signal,
      });

      return required(record(await response.json()).etag);
    }

    const response = await this.external(required(session.upload_urls[index]), {
      method: "PUT",
      headers,
      body,
      signal,
    });

    return job.provider === "oss" ? "" : required(response.headers.get("etag"));
  }

  private async finish(job: UploadCheckpoint, signal: AbortSignal): Promise<void> {
    const { session, provider } = job;

    if (provider === "local" || provider === "remote" || provider === "upyun") {
      return;
    }

    if (provider === "onedrive") {
      await this.client.request(
        `/api/v4/callback/onedrive/${encodeURIComponent(session.session_id)}/${encodeURIComponent(required(session.callback_secret))}`,
        { method: "POST", signal },
      );

      return;
    }

    if (provider === "qiniu") {
      await request(this.storage, url(required(session.upload_urls[0])), {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `UpToken ${required(session.credential)}`,
        },
        body: JSON.stringify({
          mimeType: session.mime_type ?? job.spec.mime_type,
          parts: job.parts.map((etag, index) => ({
            etag,
            partNumber: index + 1,
          })),
        }),
        redirect: "error",
        credentials: "omit",
      });

      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };

    if (provider === "cos") {
      headers["x-cos-forbid-overwrite"] = "true";
    }

    if (provider === "oss") {
      Object.assign(headers, {
        "x-oss-forbid-overwrite": "true",
        "x-oss-complete-all": "yes",
      });
    }

    const body =
      provider === "oss"
        ? ""
        : `<CompleteMultipartUpload>${job.parts.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${xml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;

    const response = await this.external(required(session.completeURL), {
      method: "POST",
      signal,
      headers,
      body,
    });

    if (/<(?:\w+:)?Error(?:\s|>)/i.test(await response.text())) {
      invalid("Storage rejected multipart completion");
    }

    if (["s3", "cos", "ks3"].includes(provider)) {
      await this.client.request(
        `/api/v4/callback/${provider}/${encodeURIComponent(session.session_id)}/${encodeURIComponent(required(session.callback_secret))}`,
        { signal },
      );
    }
  }
}
