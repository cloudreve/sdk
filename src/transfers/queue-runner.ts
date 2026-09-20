import { assertNotAborted } from "../protocol/index.ts";

/** @public */
export interface TransferJob<C> {
  id: string;
  name: string;
  source: string;
  checkpoint: C;
  status: "paused" | "queued" | "uploading" | "downloading" | "complete" | "failed";
  loaded: number;
  error?: string;
}

/** @public */
export interface TransferQueuePorts<C> {
  save(jobs: readonly TransferJob<C>[]): void | Promise<void>;
  run(
    job: TransferJob<C>,
    save: (checkpoint: C) => Promise<void>,
    progress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<C>;
  cancel(job: TransferJob<C>): Promise<void>;
}

/** A single owner for durable upload state; React only subscribes. */
/** @public */
export class TransferQueue<C extends { accountId: string; completed: boolean }> {
  private listeners = new Set<() => void>();
  private sequence: Promise<void> = Promise.resolve();
  private active = new Map<string, AbortController>();
  private jobs: readonly TransferJob<C>[];

  constructor(
    jobs: readonly TransferJob<C>[],
    private ports: TransferQueuePorts<C>,
    private runningStatus: "uploading" | "downloading",
  ) {
    this.jobs = jobs.map((job) => ({
      ...job,
      status: ["uploading", "downloading", "queued"].includes(job.status) ? "paused" : job.status,
    }));
  }

  getSnapshot = () => this.jobs;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  private writing: Promise<void> | undefined;

  private change(
    transform: (jobs: readonly TransferJob<C>[]) => readonly TransferJob<C>[],
    persist = true,
  ): void | Promise<void> {
    const apply = () => {
      const jobs = transform(this.jobs);

      const publish = () => {
        this.jobs = jobs;
        this.listeners.forEach((listener) => listener());
      };

      const saved = persist ? this.ports.save(jobs) : undefined;

      if (saved) {
        return saved.then(publish);
      }

      publish();
    };

    if (!persist) {
      return apply();
    }

    const result = this.writing ? this.writing.then(apply) : apply();

    if (result) {
      const tracked = result.finally(() => {
        if (this.writing === tracked) {
          this.writing = undefined;
        }
      });

      this.writing = tracked;

      return tracked;
    }
  }

  add(job: TransferJob<C>): void | Promise<void> {
    return this.change((jobs) => {
      if (jobs.some((existing) => existing.id === job.id)) {
        throw new Error("Transfer already queued");
      }

      return [...jobs, job];
    });
  }

  private update(id: string, patch: Partial<TransferJob<C>>, persist = true): void | Promise<void> {
    return this.change(
      (jobs) => jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      persist,
    );
  }

  pause(id: string) {
    this.active.get(id)?.abort();
  }

  pauseAccount(accountId: string) {
    this.jobs
      .filter((job) => job.checkpoint.accountId === accountId)
      .forEach((job) => this.pause(job.id));
  }

  async run(id: string): Promise<void> {
    const job = this.jobs.find((job) => job.id === id);

    if (!job || this.active.has(id) || job.status === "complete") {
      return;
    }

    const controller = new AbortController();

    this.active.set(id, controller);

    const previous = this.sequence;
    let release!: () => void;

    this.sequence = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await this.update(id, { status: "queued", error: undefined });
      await previous;
      assertNotAborted(controller.signal);
      await this.update(id, { status: this.runningStatus, error: undefined });

      await this.ports.run(
        job,
        async (checkpoint) => {
          if (checkpoint.completed) {
            assertNotAborted(controller.signal);
          }

          await this.update(id, {
            checkpoint,
            status: checkpoint.completed ? "complete" : this.runningStatus,
          });
        },
        (loaded) => {
          void this.update(id, { loaded }, false);
        },
        controller.signal,
      );
    } catch (error) {
      await this.update(id, {
        status: controller.signal.aborted ? "paused" : "failed",
        error: controller.signal.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : "Transfer failed",
      });
    } finally {
      this.active.delete(id);
      release();
    }
  }

  async remove(id: string): Promise<void> {
    if (this.active.has(id)) {
      throw new Error("Pause the transfer before removing it");
    }

    const job = this.jobs.find((job) => job.id === id);

    if (!job) {
      return;
    }

    if (!job.checkpoint.completed) {
      await this.ports.cancel(job);
    }

    await this.change((jobs) => jobs.filter((job) => job.id !== id));
  }
}
