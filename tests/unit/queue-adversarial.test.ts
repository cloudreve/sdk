import { expect, it, vi } from "vitest";
import {
  DownloadQueue,
  UploadQueue,
  parseDownloadJobs,
  parseUploadJobs,
  uploadProviders,
  type DownloadJob,
  type UploadJob,
} from "@cloudreve/sdk/transfers";

const download: DownloadJob = {
  id: "d",
  name: "file",
  source: "owned-file",
  status: "paused",
  loaded: 0,
  checkpoint: {
    accountId: "a",
    endpoint: "https://server.test",
    uri: "cloudreve://my/file",
    entity: "v1",
    name: "file",
    size: 2,
    completed: false,
  },
};

const upload: UploadJob = {
  ...download,
  checkpoint: {
    accountId: "a",
    endpoint: "https://server.test",
    spec: { uri: "cloudreve://my/file", size: 2, policy_id: "p" },
    provider: "local",
    session: {
      session_id: "s",
      uri: "cloudreve://my/file",
      expires: Date.now() / 1000 + 60,
      chunk_size: 1,
      upload_urls: [],
      credential: "",
      completeURL: "",
      callback_secret: "",
    },
    parts: [],
    completed: false,
  },
};

it("restores valid download states and optional ETags without dropping entries", () => {
  const jobs = [
    download,
    {
      ...download,
      id: "two",
      status: "failed",
      checkpoint: { ...download.checkpoint, etag: '"immutable"' },
    },
  ];

  expect(parseDownloadJobs(jobs)).toEqual(jobs);
});

it("accepts every supported upload provider without a second drift-prone provider list", () => {
  for (const provider of uploadProviders) {
    expect(
      parseUploadJobs([{ ...upload, checkpoint: { ...upload.checkpoint, provider } }])[0]
        ?.checkpoint.provider,
    ).toBe(provider);
  }
});

it.each([null, {}, "[]"])("rejects non-array durable state %#", (value) => {
  expect(() => parseUploadJobs(value)).toThrow();
  expect(() => parseDownloadJobs(value)).toThrow();
});

it.each(["id", "name", "source"])("rejects missing job identity %s", (key) => {
  expect(() => parseDownloadJobs([{ ...download, [key]: "" }])).toThrow();
  expect(() => parseUploadJobs([{ ...upload, [key]: "" }])).toThrow();
});

it.each(["accountId", "endpoint", "uri", "entity", "name"])(
  "rejects missing download identity %s",
  (key) => {
    expect(() =>
      parseDownloadJobs([{ ...download, checkpoint: { ...download.checkpoint, [key]: "" } }]),
    ).toThrow();
  },
);

it.each(["accountId", "endpoint"])("rejects missing upload account %s", (key) => {
  expect(() =>
    parseUploadJobs([{ ...upload, checkpoint: { ...upload.checkpoint, [key]: "" } }]),
  ).toThrow();
});

it.each(["uri", "policy_id"])("rejects missing upload spec %s", (key) => {
  expect(() =>
    parseUploadJobs([
      {
        ...upload,
        checkpoint: {
          ...upload.checkpoint,
          spec: { ...upload.checkpoint.spec, [key]: "" },
        },
      },
    ]),
  ).toThrow();
});

it.each([-1, 1.5, NaN, "2"])("rejects invalid expected size %s", (size) => {
  expect(() =>
    parseDownloadJobs([{ ...download, checkpoint: { ...download.checkpoint, size } }]),
  ).toThrow();

  expect(() =>
    parseUploadJobs([
      {
        ...upload,
        checkpoint: {
          ...upload.checkpoint,
          spec: { ...upload.checkpoint.spec, size },
        },
      },
    ]),
  ).toThrow();
});

it.each([-1, 0.5, 3, NaN, Infinity, "1"])("rejects invalid persisted byte count %s", (loaded) => {
  expect(() => parseDownloadJobs([{ ...download, loaded }])).toThrow();
  expect(() => parseUploadJobs([{ ...upload, loaded }])).toThrow();
});

it("rejects duplicate IDs, unknown states, invalid flags, validators, parts and sessions", () => {
  expect(() => parseDownloadJobs([download, download])).toThrow();
  expect(() => parseUploadJobs([upload, upload])).toThrow();

  for (const job of [download, upload]) {
    const parse = job === download ? parseDownloadJobs : parseUploadJobs;

    expect(() => parse([{ ...job, status: "unknown" }])).toThrow();
    expect(() => parse([{ ...job, checkpoint: { ...job.checkpoint, completed: 1 } }])).toThrow();
  }

  expect(() =>
    parseDownloadJobs([{ ...download, checkpoint: { ...download.checkpoint, etag: 1 } }]),
  ).toThrow();

  for (const patch of [{ provider: "unknown" }, { parts: {} }, { parts: [1] }, { session: {} }]) {
    expect(() =>
      parseUploadJobs([{ ...upload, checkpoint: { ...upload.checkpoint, ...patch } }]),
    ).toThrow();
  }
});

it.each([
  "ftp://server.test",
  "https://user@server.test",
  "https://:secret@server.test",
  "https://server.test/path",
  "invalid",
])("rejects malformed or credential-bearing endpoints %s", (endpoint) => {
  expect(() =>
    parseDownloadJobs([{ ...download, checkpoint: { ...download.checkpoint, endpoint } }]),
  ).toThrow();

  expect(() =>
    parseUploadJobs([{ ...upload, checkpoint: { ...upload.checkpoint, endpoint } }]),
  ).toThrow();
});

it("rejects non-Cloudreve download URIs", () => {
  expect(() =>
    parseDownloadJobs([
      {
        ...download,
        checkpoint: { ...download.checkpoint, uri: "https://server.test/file" },
      },
    ]),
  ).toThrow();
});

function fixture(jobs: DownloadJob[] = [download]) {
  const save = vi.fn((_jobs: readonly DownloadJob[]) => {});

  const destination = {
    size: () => 0,
    reset: async () => {},
    append: async () => {},
    close: async () => {},
  };

  const run = vi.fn(
    async (
      checkpoint: DownloadJob["checkpoint"],
      _destination: typeof destination,
      checkpointSave: (checkpoint: DownloadJob["checkpoint"]) => Promise<void>,
      progress: (loaded: number) => void,
      _signal: AbortSignal,
    ) => {
      await checkpointSave({ ...checkpoint, etag: '"v1"' });
      progress(2);

      const completed = { ...checkpoint, completed: true };

      await checkpointSave(completed);

      return completed;
    },
  );

  const resolve = vi.fn((_accountId: string) => ({ run }));
  const resolveDestination = vi.fn((_reference: string) => destination);

  const queue = new DownloadQueue(jobs, {
    save,
    destination: resolveDestination,
    downloads: resolve,
  });

  return { queue, save, run, resolve, resolveDestination };
}

it("binds account and destination, emits progress without persisting each event, unsubscribes", async () => {
  const s = fixture();
  const listener = vi.fn();
  const unsubscribe = s.queue.subscribe(listener);

  await s.queue.run("d");
  expect(s.resolve).toHaveBeenCalledWith("a");
  expect(s.resolveDestination).toHaveBeenCalledWith("owned-file");

  expect(s.queue.getSnapshot()[0]).toMatchObject({
    status: "complete",
    loaded: 2,
    checkpoint: { completed: true },
  });

  expect(listener).toHaveBeenCalledTimes(5);
  expect(s.save).toHaveBeenCalledTimes(4);
  unsubscribe();
  await s.queue.remove("d");
  expect(listener).toHaveBeenCalledTimes(5);
  expect(s.queue.getSnapshot()).toEqual([]);
});

it("add is durable and rejects duplicate IDs; completed/missing runs and removals are no-ops", async () => {
  const s = fixture([]);

  s.queue.add(download);
  expect(() => s.queue.add(download)).toThrow("already queued");
  await s.queue.run("missing");
  await s.queue.remove("missing");

  s.queue.add({
    ...download,
    id: "complete",
    status: "complete",
    checkpoint: { ...download.checkpoint, completed: true },
  });

  await s.queue.run("complete");
  expect(s.run).not.toHaveBeenCalled();
  await s.queue.remove("d");
  expect(s.queue.getSnapshot()).toHaveLength(1);
});

it("preserves snapshots when durable add/remove writes fail", async () => {
  const s = fixture();
  const before = s.queue.getSnapshot();

  s.save.mockImplementation(() => {
    throw new Error("disk full");
  });

  expect(() => s.queue.add({ ...download, id: "new" })).toThrow("disk full");
  await expect(s.queue.remove("d")).rejects.toThrow("disk full");
  expect(s.queue.getSnapshot()).toBe(before);
});

it.each([new Error("network failed"), "unknown failure"])(
  "records failures and allows retry %#",
  async (error) => {
    const s = fixture();

    s.run.mockRejectedValueOnce(error);
    await s.queue.run("d");

    expect(s.queue.getSnapshot()[0]).toMatchObject({
      status: "failed",
      error: error instanceof Error ? error.message : "Transfer failed",
    });

    await s.queue.run("d");
    expect(s.queue.getSnapshot()[0]?.status).toBe("complete");
  },
);

it("releases serialization after persistence failure so another account is not stranded", async () => {
  const s = fixture([
    download,
    {
      ...download,
      id: "b",
      checkpoint: { ...download.checkpoint, accountId: "b" },
    },
  ]);

  s.save.mockImplementationOnce(() => {
    throw new Error("disk full");
  });

  await s.queue.run("d");
  expect(s.queue.getSnapshot()[0]?.status).toBe("failed");
  await s.queue.run("b");
  expect(s.queue.getSnapshot()[1]?.status).toBe("complete");
});

it("keeps the last checkpoint when persisting a new checkpoint fails", async () => {
  const s = fixture();

  s.save.mockImplementation((jobs) => {
    if (jobs[0]?.checkpoint.etag) {
      throw new Error("checkpoint disk full");
    }
  });

  await s.queue.run("d");

  expect(s.queue.getSnapshot()[0]).toMatchObject({
    status: "failed",
    error: "checkpoint disk full",
    checkpoint: { completed: false },
  });

  expect(s.queue.getSnapshot()[0]?.checkpoint.etag).toBeUndefined();
});

it("pauses account work running or waiting, ignores a late completion, and leaves other accounts queued", async () => {
  const s = fixture([
    download,
    { ...download, id: "a2" },
    {
      ...download,
      id: "b",
      checkpoint: { ...download.checkpoint, accountId: "b" },
    },
  ]);

  let release!: () => void;

  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });

  s.run.mockImplementationOnce(async (checkpoint, _sink, save) => {
    await wait;

    const complete = { ...checkpoint, completed: true };

    await save(complete);

    return complete;
  });

  const first = s.queue.run("d");
  const waiting = s.queue.run("a2");
  const other = s.queue.run("b");

  await vi.waitFor(() => expect(s.run).toHaveBeenCalledTimes(1));
  await expect(s.queue.remove("d")).rejects.toThrow("Pause the transfer");
  await s.queue.run("d");
  expect(s.run).toHaveBeenCalledTimes(1);
  s.queue.pauseAccount("a");
  s.queue.pause("missing");
  release();
  await Promise.all([first, waiting, other]);
  expect(s.queue.getSnapshot().map((job) => job.status)).toEqual(["paused", "paused", "complete"]);
  expect(s.queue.getSnapshot()[0]?.checkpoint.completed).toBe(false);
  expect(s.run).toHaveBeenCalledTimes(2);
});

it("cancels incomplete uploads through their account and preserves the job on cancellation failure", async () => {
  const cancel = vi.fn(async () => {});
  const resolve = vi.fn(() => ({ run: vi.fn(), cancel }));

  const q = new UploadQueue([upload], {
    save: () => {},
    source: vi.fn(),
    uploads: resolve,
  });

  cancel.mockRejectedValueOnce(new Error("server unavailable"));
  await expect(q.remove("d")).rejects.toThrow("server unavailable");
  expect(q.getSnapshot()).toHaveLength(1);
  await q.remove("d");
  expect(resolve).toHaveBeenCalledWith("a");
  expect(cancel).toHaveBeenCalledWith(upload.checkpoint);
  expect(q.getSnapshot()).toEqual([]);
});
