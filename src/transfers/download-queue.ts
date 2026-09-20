import { DownloadJobsSchema } from "./schemas.ts";
import { decode } from "../protocol/index.ts";
import { TransferQueue, type TransferJob } from "./queue-runner.ts";
import type { Downloads, DownloadCheckpoint, DownloadDestination } from "./download.ts";

/** @public */
export type DownloadJob = TransferJob<DownloadCheckpoint>;

/** @public */
export class DownloadQueue extends TransferQueue<DownloadCheckpoint> {
  constructor(
    jobs: readonly DownloadJob[],
    ports: {
      save(jobs: readonly DownloadJob[]): void | Promise<void>;
      downloads(accountId: string): Pick<Downloads, "run">;
      destination(reference: string): DownloadDestination;
    },
  ) {
    super(
      jobs,
      {
        save: ports.save,
        run: (job, save, progress, signal) =>
          ports
            .downloads(job.checkpoint.accountId)
            .run(job.checkpoint, ports.destination(job.source), save, progress, signal),
        cancel: async () => {},
      },
      "downloading",
    );
  }
}

/** @public */
export function parseDownloadJobs(value: unknown): DownloadJob[] {
  return decode(DownloadJobsSchema, value, "Invalid saved downloads or source") as DownloadJob[];
}
