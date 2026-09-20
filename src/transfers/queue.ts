import { TransferQueue, type TransferJob } from "./queue-runner.ts";
import { UploadJobsSchema } from "./schemas.ts";
import { decode } from "../protocol/index.ts";
import {
  parseUploadSession,
  type Uploads,
  type UploadCheckpoint,
  type UploadSource,
} from "./upload.ts";

/** @public */
export type UploadJob = TransferJob<UploadCheckpoint>;

/** @public */
export interface UploadQueuePorts {
  save(jobs: readonly UploadJob[]): void | Promise<void>;
  uploads(accountId: string): Pick<Uploads, "run" | "cancel">;
  source(reference: string): UploadSource;
}

/** @public */
export class UploadQueue extends TransferQueue<UploadCheckpoint> {
  constructor(jobs: readonly UploadJob[], ports: UploadQueuePorts) {
    super(
      jobs,
      {
        save: ports.save,
        run: (job, save, progress, signal) =>
          ports
            .uploads(job.checkpoint.accountId)
            .run(job.checkpoint, ports.source(job.source), save, progress, signal),
        cancel: (job) => ports.uploads(job.checkpoint.accountId).cancel(job.checkpoint),
      },
      "uploading",
    );
  }
}

/** Corrupt state is preserved by the caller for recovery, never silently discarded. */
/** @public */
export function parseUploadJobs(value: unknown): UploadJob[] {
  return decode(UploadJobsSchema, value, "Invalid saved upload queue or account").map((job) => ({
    ...job,
    checkpoint: {
      ...job.checkpoint,
      session: parseUploadSession(job.checkpoint.session),
    },
  })) as UploadJob[];
}
