import * as v from "valibot";
import { natural, nonempty, finite } from "../protocol/index.ts";

/** @public */
export const uploadProviderValues = [
  "local",
  "remote",
  "s3",
  "cos",
  "ks3",
  "oss",
  "obs",
  "qiniu",
  "onedrive",
  "upyun",
] as const;

const endpoint = v.pipe(
  nonempty,
  v.check((value) => {
    try {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

const uri = v.pipe(
  nonempty,
  v.check((value) => {
    try {
      return new URL(value).protocol === "cloudreve:";
    } catch {
      return false;
    }
  }),
);

const identity = {
  id: nonempty,
  name: nonempty,
  source: nonempty,
  loaded: natural,
};

/** @public */
export const UploadSpecSchema = v.looseObject({
  uri,
  size: natural,
  policy_id: nonempty,
  entity_type: v.optional(v.picklist(["version", "live_photo"])),
  previous: v.optional(nonempty),
  metadata: v.optional(v.record(v.string(), v.string())),
  mime_type: v.optional(v.string()),
  last_modified: v.optional(finite),
  encryption_supported: v.optional(v.tuple([v.literal("aes-256-ctr")])),
});

/** @public */
export const UploadJobSchema = v.pipe(
  v.looseObject({
    ...identity,
    status: v.picklist(["paused", "queued", "uploading", "complete", "failed"]),
    checkpoint: v.looseObject({
      accountId: nonempty,
      endpoint,
      spec: UploadSpecSchema,
      provider: v.picklist(uploadProviderValues),
      parts: v.array(v.string()),
      completed: v.boolean(),
      session: v.unknown(),
    }),
  }),
  v.check((job) => job.loaded <= job.checkpoint.spec.size),
);

/** @public */
export const DownloadJobSchema = v.pipe(
  v.looseObject({
    ...identity,
    status: v.picklist(["paused", "queued", "downloading", "complete", "failed"]),
    checkpoint: v.looseObject({
      accountId: nonempty,
      scope: v.optional(v.never()),
      endpoint,
      uri,
      entity: nonempty,
      name: nonempty,
      size: natural,
      completed: v.boolean(),
      etag: v.optional(v.string()),
    }),
  }),
  v.check((job) => job.loaded <= job.checkpoint.size),
);

/** @public */
export const UploadJobsSchema = v.pipe(
  v.array(UploadJobSchema),
  v.check((jobs) => new Set(jobs.map((job) => job.id)).size === jobs.length),
);

/** @public */
export const DownloadJobsSchema = v.pipe(
  v.array(DownloadJobSchema),
  v.check((jobs) => new Set(jobs.map((job) => job.id)).size === jobs.length),
);

/** @public */
export const UploadSessionSchema = v.looseObject({
  session_id: nonempty,
  uri: nonempty,
  expires: finite,
  chunk_size: natural,
  upload_urls: v.nullish(v.array(nonempty), []),
});

/** Password-free anonymous checkpoint; account and guest scopes cannot be mixed. @public */
export const GuestDownloadCheckpointSchema = v.strictObject({
  scope: v.literal("guest"),
  endpoint,
  uri,
  entity: nonempty,
  name: nonempty,
  size: natural,
  etag: v.optional(v.string()),
  completed: v.boolean(),
});
