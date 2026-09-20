import { it, expect, vi } from "vitest";
import { UploadQueue, parseUploadJobs, type UploadJob } from "@cloudreve/sdk/transfers";

const job: UploadJob = {
  id: "job",
  name: "a.txt",
  source: "owned-file",
  status: "uploading",
  loaded: 1,
  checkpoint: {
    accountId: "a",
    endpoint: "https://server.test",
    spec: { uri: "cloudreve://my/a.txt", size: 2, policy_id: "p" },
    provider: "local",
    session: {
      session_id: "s",
      uri: "cloudreve://my/a.txt",
      expires: Date.now() / 1000 + 60,
      chunk_size: 1,
      upload_urls: [],
      credential: "",
      completeURL: "",
      callback_secret: "",
    },
    parts: [""],
    completed: false,
  },
};

it("restores active work as paused, deduplicates execution and persists acknowledged completion", async () => {
  let runs = 0;
  let release!: () => void;

  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });

  let saved: readonly UploadJob[] = [];

  const queue = new UploadQueue(parseUploadJobs([job]), {
    save: (jobs) => {
      saved = jobs;
    },
    source: () => ({
      size: 2,
      chunk: async () => {
        throw new Error("unexpected");
      },
    }),
    uploads: () => ({
      run: async (checkpoint, _source, save) => {
        runs++;
        await wait;
        await save({ ...checkpoint, completed: true });

        return { ...checkpoint, completed: true };
      },
      cancel: async () => {},
    }),
  });

  expect(queue.getSnapshot()[0]!.status).toBe("paused");

  const pending = queue.run("job");

  await queue.run("job");
  await vi.waitFor(() => expect(runs).toBe(1));
  release();
  await pending;
  expect(saved[0]!.status).toBe("complete");
});

it("refuses corrupt persisted state without silently deleting jobs", () => {
  expect(() =>
    parseUploadJobs([{ ...job, checkpoint: { ...job.checkpoint, parts: [7] } }]),
  ).toThrow();

  expect(() => parseUploadJobs([job, job])).toThrow();
});

it("serializes different jobs and does not start a cancelled waiting job", async () => {
  let release!: () => void;

  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started: string[] = [];

  const queue = new UploadQueue(
    [
      { ...job, status: "paused" },
      { ...job, id: "second", status: "paused" },
    ],
    {
      save: () => {},
      source: () => ({
        size: 2,
        chunk: async () => {
          throw new Error("unexpected");
        },
      }),
      uploads: () => ({
        cancel: async () => {},
        run: async (checkpoint, _source, save) => {
          started.push(checkpoint.session.session_id);
          await waiting;

          const completed = { ...checkpoint, completed: true };

          await save(completed);

          return completed;
        },
      }),
    },
  );

  const first = queue.run("job");
  const second = queue.run("second");

  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(queue.getSnapshot().find((j) => j.id === "second")?.status).toBe("queued");
  queue.pause("second");
  release();
  await Promise.all([first, second]);
  expect(started).toHaveLength(1);
  expect(queue.getSnapshot().find((j) => j.id === "second")?.status).toBe("paused");
});
