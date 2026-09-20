import { expect, it, vi } from "vitest";
import { AccountClient } from "@cloudreve/sdk/session";
import {
  Downloads,
  type DownloadCheckpoint,
  type DownloadDestination,
} from "@cloudreve/sdk/transfers";
import type { Transport, TransportResponse } from "@cloudreve/sdk/protocol";

const job: DownloadCheckpoint = {
  accountId: "a",
  endpoint: "https://cloud.test",
  uri: "cloudreve://my/a",
  entity: "v1",
  name: "a",
  size: 4,
  completed: false,
};

const file = {
  id: "a",
  name: "a",
  path: job.uri,
  type: 0,
  size: 4,
  primary_entity: "v1",
  created_at: "",
  updated_at: "",
};

function setup(
  storage: Transport = async () => new Response(new Uint8Array([1, 2, 3, 4])),
  data: unknown = { urls: [{ url: "https://storage.test/signed" }] },
) {
  const client = new AccountClient({
    accountId: job.accountId,
    endpoint: job.endpoint,
    tokens: () => ({
      accessToken: "never-send-to-storage",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
    transport: async () => Response.json({ code: 0, data }),
  });

  const bytes: number[] = [];

  const destination: DownloadDestination = {
    size: () => bytes.length,
    reset: vi.fn(async () => {
      bytes.length = 0;
    }),
    append: vi.fn(async (chunk) => {
      bytes.push(...chunk);
    }),
    close: vi.fn(async () => {}),
  };

  const save = vi.fn(async (_job: DownloadCheckpoint) => {});
  const progress = vi.fn();
  const controller = new AbortController();
  const downloads = new Downloads(client, storage);

  return {
    client,
    downloads,
    destination,
    bytes,
    save,
    progress,
    controller,
    run: (checkpoint = job) =>
      downloads.run(checkpoint, destination, save, progress, controller.signal),
  };
}

it("prepares current and historical entity identities and sizes independently", async () => {
  const current = setup(undefined, file);

  expect(await current.downloads.prepare(job.uri)).toMatchObject({ ...job });

  const historical = setup(undefined, {
    ...file,
    extended_info: {
      entities: [{ id: "old", size: 2, created_at: "", type: 0 }],
    },
  });

  expect(await historical.downloads.prepare(job.uri, "old")).toMatchObject({
    entity: "old",
    size: 2,
  });

  await expect(historical.downloads.prepare(job.uri, "missing")).rejects.toThrow("unavailable");
  await expect(current.downloads.prepare(job.uri, "missing")).rejects.toThrow("unavailable");
});

it.each([
  { ...file, type: 1 },
  { ...file, primary_entity: undefined },
  { ...file, primary_entity: "" },
  { ...file, size: -1 },
  { ...file, size: 1.5 },
])("rejects unusable source metadata %#", async (data) => {
  await expect(setup(undefined, data).downloads.prepare(job.uri)).rejects.toThrow();
});

it.each([
  { accountId: "other" },
  { endpoint: "https://other.test" },
  { entity: "" },
  { size: -1 },
  { size: NaN },
])("refuses foreign or corrupt checkpoints before transport %#", async (patch) => {
  const storage = vi.fn();
  const s = setup(storage);

  await expect(s.run({ ...job, ...patch })).rejects.toThrow();
  expect(storage).not.toHaveBeenCalled();
  expect(s.save).not.toHaveBeenCalled();
});

it.each([-1, NaN, 1.5, 5])("refuses invalid local offset %s", async (size) => {
  const s = setup();

  s.destination.size = () => size;
  await expect(s.run()).rejects.toThrow("Invalid partial");
  expect(s.destination.close).toHaveBeenCalled();
});

it("skips completed bytes but re-fetches a completed checkpoint whose local file is incomplete", async () => {
  const storage = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  const s = setup(storage);

  s.bytes.push(1, 2, 3, 4);

  expect(await s.run({ ...job, completed: true })).toMatchObject({
    completed: true,
  });

  expect(storage).not.toHaveBeenCalled();
  s.bytes.pop();
  await s.run({ ...job, completed: true });
  expect(s.bytes).toEqual([1, 2, 3, 4]);
});

it.each(["user", "account"])("honors pre-cancelled %s lifetime", async (owner) => {
  const storage = vi.fn();
  const s = setup(storage);

  if (owner === "user") {
    s.controller.abort();
  } else {
    s.client.invalidate();
  }

  await expect(s.run()).rejects.toThrow("cancelled");
  expect(storage).not.toHaveBeenCalled();
});

it("does not write a chunk delivered after cancellation", async () => {
  let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;

  const reader = {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        resolveRead = resolve;
      }),
    cancel: vi.fn(async () => {}),
  };

  const s = setup(
    async () =>
      ({
        ...new Response(),
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { getReader: () => reader },
      }) as unknown as TransportResponse,
  );

  const running = s.run();

  await vi.waitFor(() => expect(resolveRead).toBeDefined());
  s.controller.abort();
  resolveRead({ done: false, value: new Uint8Array([1, 2, 3, 4]) });
  await expect(running).rejects.toThrow("cancelled");
  expect(s.bytes).toEqual([]);
  expect(reader.cancel).toHaveBeenCalled();
});

it("does not persist completion if account lifetime ends while closing the sink", async () => {
  const s = setup();

  s.destination.close = async () => {
    s.client.invalidate();
  };

  await expect(s.run()).rejects.toThrow("cancelled");
  expect(s.save.mock.calls.every(([next]) => !next.completed)).toBe(true);
});

it.each([401, 403])(
  "renews %s once, retains entity, and keeps credentials off storage requests",
  async (status) => {
    const storage = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);

      return new Response(null, { status });
    });

    const s = setup(storage);

    await expect(s.run()).rejects.toThrow(`Download failed (${status})`);
    expect(storage).toHaveBeenCalledTimes(2);
    expect(s.save).not.toHaveBeenCalled();
  },
);

it.each([500, 404, 416, 204])("rejects HTTP %s without declaring completion", async (status) => {
  const s = setup(async () => new Response(null, { status }));

  await expect(s.run()).rejects.toThrow();
  expect(s.save).not.toHaveBeenCalled();
});

it("requires a download URL", async () => {
  await expect(setup(undefined, { urls: [] }).run()).rejects.toThrow("No download URL");
});

it.each([undefined, "bytes */3", "bytes */5"])(
  "does not trust 416 without matching total %s",
  async (range) => {
    const s = setup(
      async () =>
        new Response(null, {
          status: 416,
          headers: range ? { "Content-Range": range } : {},
        }),
    );

    s.bytes.push(1, 2, 3, 4);
    await expect(s.run()).rejects.toThrow("incompatible completed range");
    expect(s.save).not.toHaveBeenCalled();
  },
);

it("accepts an exact completed 416 only with matching known validator", async () => {
  const s = setup(
    async () =>
      new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */4", ETag: '"v1"' },
      }),
  );

  s.bytes.push(1, 2, 3, 4);
  expect((await s.run({ ...job, etag: '"v1"' })).completed).toBe(true);
  await expect(s.run({ ...job, etag: '"other"' })).rejects.toThrow("incompatible completed range");
  expect((await s.run()).completed).toBe(true);
});

it.each(["", "bytes 1-3/4", "bytes 2-2/4", "bytes 2-3/5"])(
  "rejects incompatible range %s before writing",
  async (range) => {
    const s = setup(
      async () =>
        new Response(new Uint8Array([3, 4]), {
          status: 206,
          headers: { "Content-Range": range },
        }),
    );

    s.bytes.push(1, 2);
    await expect(s.run()).rejects.toThrow("incompatible byte range");
    expect(s.bytes).toEqual([1, 2]);
  },
);

it("resumes without ETag when a provider omits it", async () => {
  const s = setup(async (_url, init) => {
    expect(new Headers(init?.headers).has("If-Range")).toBe(false);

    return new Response(new Uint8Array([3, 4]), {
      status: 206,
      headers: { "Content-Range": "bytes 2-3/4" },
    });
  });

  s.bytes.push(1, 2);
  await s.run();
  expect(s.bytes).toEqual([1, 2, 3, 4]);
});

it("accepts a zero-byte 200 without a stream but rejects absent nonempty streams", async () => {
  const s = setup(async () => new Response(null));

  await s.run({ ...job, size: 0 });

  expect(s.save).toHaveBeenLastCalledWith({
    ...job,
    size: 0,
    etag: undefined,
    completed: true,
  });

  await expect(s.run()).rejects.toThrow("Streaming download is unavailable");
});

it("rejects oversized streams before appending the excess", async () => {
  const s = setup(async () => new Response(new Uint8Array([1, 2, 3, 4, 5])));

  await expect(s.run()).rejects.toThrow("exceeded");
  expect(s.bytes).toEqual([]);
});

it("uses native streaming and reports total progress from a partial offset", async () => {
  const s = setup(
    async () =>
      new Response(null, {
        status: 206,
        headers: { "Content-Range": "bytes 2-3/4" },
      }),
  );

  s.bytes.push(1, 2);

  s.destination.receive = async (_response, offset, remaining, progress) => {
    expect(offset).toBe(2);
    expect(remaining).toBe(2);
    progress(1);
    s.bytes.push(3, 4);

    return 2;
  };

  await s.run();
  expect(s.progress.mock.calls).toEqual([[3], [4]]);
  expect(s.bytes).toEqual([1, 2, 3, 4]);
});

it.each([-1, 3, 5, NaN])(
  "refuses incomplete or invalid native receive result %s",
  async (received) => {
    const s = setup();

    s.destination.receive = async () => received;
    await expect(s.run()).rejects.toThrow("interrupted");
    expect(s.save.mock.calls.every(([next]) => !next.completed)).toBe(true);
  },
);

it("does not consume bytes if saving the identity checkpoint fails", async () => {
  const s = setup();

  s.save.mockRejectedValue(new Error("disk full"));
  await expect(s.run()).rejects.toThrow("disk full");
  expect(s.bytes).toEqual([]);
  expect(s.destination.close).toHaveBeenCalled();
});

it("preserves the transfer error when cleanup cancellation rejects", async () => {
  const body = {
    cancel: vi.fn(async () => {
      throw new Error("already closed");
    }),
  };

  const failed = setup(
    async () =>
      ({
        ok: false,
        status: 500,
        headers: new Headers(),
        body,
      }) as unknown as TransportResponse,
  );

  await expect(failed.run()).rejects.toThrow("Download failed (500)");
  expect(failed.destination.close).toHaveBeenCalled();

  const reader = {
    read: async () => {
      throw new Error("network interrupted");
    },
    cancel: vi.fn(async () => {
      throw new Error("already closed");
    }),
  };

  const streaming = setup(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { getReader: () => reader },
      }) as unknown as TransportResponse,
  );

  await expect(streaming.run()).rejects.toThrow("network interrupted");
  expect(streaming.destination.close).toHaveBeenCalled();
});

it("preserves signed provider query bytes and never substitutes a Cloudreve token", async () => {
  const signed =
    "https://storage.test/file?sig=ABC%2Bdef%2Fghi%3D&part=1&response-content-disposition=attachment%3B%20filename%3D%22a.txt%22";

  const storage = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(signed);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);

    return new Response(new Uint8Array([1, 2, 3, 4]));
  });

  await setup(storage, { urls: [{ url: signed }] }).run();
  expect(storage).toHaveBeenCalledOnce();
});

it("does not contact storage when URL resolution returns an invalid contract", async () => {
  const storage = vi.fn();

  await expect(setup(storage, { urls: [{ url: "javascript:bad" }] }).run()).rejects.toThrow(
    "Unsupported file URL",
  );

  expect(storage).not.toHaveBeenCalled();
});

it("propagates sink write failure without marking a partial file complete", async () => {
  const s = setup();

  s.destination.append = async () => {
    throw new Error("disk full");
  };

  await expect(s.run()).rejects.toThrow("disk full");
  expect(s.save.mock.calls.every(([next]) => !next.completed)).toBe(true);
  expect(s.destination.close).toHaveBeenCalled();
});
