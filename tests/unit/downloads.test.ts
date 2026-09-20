import { it, expect } from "vitest";
import { AccountClient } from "@cloudreve/sdk/session";
import {
  Downloads,
  type DownloadCheckpoint,
  type DownloadDestination,
} from "@cloudreve/sdk/transfers";
import type { Transport } from "@cloudreve/sdk/protocol";

const job: DownloadCheckpoint = {
  accountId: "a",
  endpoint: "https://cloud.test",
  uri: "cloudreve://my/test",
  entity: "immutable",
  name: "test",
  size: 4,
  etag: '"immutable"',
  completed: false,
};

function setup(transport: Transport) {
  const requested: unknown[] = [];

  const client = new AccountClient({
    accountId: "a",
    endpoint: job.endpoint,
    transport: async (_url, init) => {
      requested.push(JSON.parse(String(init?.body)));

      return Response.json({
        code: 0,
        data: { urls: [{ url: "https://storage.test/file" }] },
      });
    },
    tokens: () => ({
      accessToken: "account-secret",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
  });

  return { downloads: new Downloads(client, transport), requested };
}

function sink(initial: number[] = []) {
  let bytes = initial;
  let closed = false;

  const destination: DownloadDestination = {
    size: () => bytes.length,
    reset: async () => {
      bytes = [];
    },
    append: async (next) => {
      bytes.push(...next);
    },
    close: async () => {
      closed = true;
    },
  };

  return { destination, bytes: () => bytes, closed: () => closed };
}

it("resumes the pinned entity with correct Range and no account credentials", async () => {
  const { downloads, requested } = setup(async (_url, init) => {
    const headers = new Headers(init?.headers);

    expect(headers.get("range")).toBe("bytes=2-");
    expect(headers.has("authorization")).toBe(false);

    return new Response(new Uint8Array([3, 4]), {
      status: 206,
      headers: { "content-range": "bytes 2-3/4", etag: '"immutable"' },
    });
  });

  const target = sink([1, 2]);

  const result = await downloads.run(
    job,
    target.destination,
    async () => {},
    () => {},
    new AbortController().signal,
  );

  expect(result.completed).toBe(true);
  expect(target.bytes()).toEqual([1, 2, 3, 4]);
  expect(requested).toEqual([{ uris: [job.uri], download: true, entity: "immutable" }]);
  expect(target.closed()).toBe(true);
});

it("restarts safely when a server ignores Range instead of appending duplicate bytes", async () => {
  const { downloads } = setup(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  const target = sink([8, 9]);

  await downloads.run(
    job,
    target.destination,
    async () => {},
    () => {},
    new AbortController().signal,
  );

  expect(target.bytes()).toEqual([1, 2, 3, 4]);
});

it("rejects wrong ranges and changed entities before writing", async () => {
  for (const headers of [
    { "content-range": "bytes 0-1/4", etag: '"immutable"' },
    { "content-range": "bytes 2-3/4", etag: '"different"' },
  ]) {
    const { downloads } = setup(
      async () => new Response(new Uint8Array([3, 4]), { status: 206, headers }),
    );

    const target = sink([1, 2]);

    await expect(
      downloads.run(
        job,
        target.destination,
        async () => {},
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    expect(target.bytes()).toEqual([1, 2]);
    expect(target.closed()).toBe(true);
  }
});

it("renews an expired signed URL for the same entity and rejects a truncated body", async () => {
  let calls = 0;

  const { downloads, requested } = setup(async () =>
    ++calls === 1 ? new Response("", { status: 403 }) : new Response(new Uint8Array([1])),
  );

  const target = sink();

  await expect(
    downloads.run(
      job,
      target.destination,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("interrupted");

  expect(requested).toHaveLength(2);
  expect(requested[1]).toMatchObject({ entity: "immutable", no_cache: true });
  expect(target.bytes()).toEqual([1]);
});

it("keeps partial bytes but never marks completion after cancellation", async () => {
  const controller = new AbortController();
  const target = sink();
  const append = target.destination.append;

  target.destination.append = async (bytes) => {
    await append(bytes);
    controller.abort();
  };

  const { downloads } = setup(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  let completed = false;

  await expect(
    downloads.run(
      job,
      target.destination,
      async (next) => {
        completed = next.completed;
      },
      () => {},
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");

  expect(completed).toBe(false);
  expect(target.closed()).toBe(true);
});
