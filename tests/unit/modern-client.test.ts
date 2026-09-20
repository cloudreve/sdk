import { afterAll, beforeAll, afterEach, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import fc from "fast-check";
import { createClient } from "@cloudreve/sdk/client";
import {
  AccountClient,
  tokensFromOAuth,
  tokensFromPassword,
  type SessionRecord,
  type SessionExclusive,
} from "@cloudreve/sdk/session";
import { request } from "@cloudreve/sdk/protocol";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const token = () => ({
  accessToken: "old",
  refreshToken: "refresh",
  accessExpiresAt: 0,
  refreshExpiresAt: Date.now() + 60000,
});

function store() {
  let value: SessionRecord = { generation: "login-a", tokens: token() };
  let tail = Promise.resolve();

  const exclusive: SessionExclusive = async (fn) => {
    const prev = tail;
    let release!: () => void;

    tail = new Promise((r) => (release = r));
    await prev;

    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    store: {
      read: async () => structuredClone(value),
      write: async (v: SessionRecord) => {
        value = structuredClone(v);
      },
    },
    exclusive,
    get: () => value,
    set: (v: SessionRecord) => {
      value = v;
    },
  };
}

const replacement = () => ({
  access_token: "new",
  refresh_token: "rotated",
  access_expires: new Date(Date.now() + 600000).toISOString(),
  refresh_expires: new Date(Date.now() + 1200000).toISOString(),
});

const options = (s: ReturnType<typeof store>) => ({
  endpoint: "https://cloud.test",
  accountId: "u",
  transport: fetch,
  store: s.store,
  exclusive: s.exclusive,
});

it("exposes stable resources and shares one refresh across two coordinators using the same transaction", async () => {
  const s = store();
  let refreshes = 0;

  server.use(
    http.post("https://cloud.test/api/v4/session/token/refresh", () => {
      refreshes++;

      return HttpResponse.json({ code: 0, data: replacement() });
    }),
    http.get("https://cloud.test/api/v4/user/me", ({ request }) =>
      HttpResponse.json({
        code: 0,
        data: { id: "u", nickname: request.headers.get("Authorization") },
      }),
    ),
  );

  const a = await createClient(options(s));
  const b = await createClient(options(s));

  expect(a.files).toBe(a.files);
  expect(a.uploads).toBe(a.uploads);

  const listener = vi.fn();
  const off = a.session.subscribe(listener);

  expect((await Promise.all([a.account.me(), b.account.me()])).map((v) => v.nickname)).toEqual([
    "Bearer new",
    "Bearer new",
  ]);

  expect(refreshes).toBe(1);
  expect(s.get().tokens?.refreshToken).toBe("rotated");
  expect(listener).toHaveBeenCalled();
  expect(a.session.getSnapshot().status).toBe("authenticated");
  off();
  await a.session.logout();
  expect(s.get().tokens).toBeNull();
  expect(a.session.getSnapshot().status).toBe("invalidated");
});

it("cancels one refresh waiter promptly while preserving another request and revokes after local logout", async () => {
  const s = store();
  let release!: (v: Response) => void;
  const refresh = vi.fn(() => new Promise<Response>((r) => (release = r)));

  const transport = vi.fn(async (url: string) =>
    url.endsWith("/refresh") ? refresh() : HttpResponse.json({ code: 0, data: "done" }),
  );

  const client = new AccountClient({ ...options(s), transport });

  await client.ready();

  const cancel = new AbortController();
  const first = client.request("/api/v4/file", { signal: cancel.signal });
  const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
  const second = client.request("/api/v4/file");

  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  cancel.abort();
  await rejected;
  expect(s.get().tokens?.accessToken).toBe("old");
  release(HttpResponse.json({ code: 0, data: replacement() }));
  expect(await second).toBe("done");
  await client.logout({ revoke: true });
  expect(s.get().tokens).toBeNull();
  expect(transport.mock.calls.at(-1)?.[0]).toBe("https://cloud.test/api/v4/session/token");
});

it("protects new login generations from an obsolete logout and exposes unavailable/expired state", async () => {
  const s = store();
  const client = new AccountClient(options(s));

  await client.ready();
  s.set({ generation: "login-b", tokens: token() });
  await client.logout();
  expect(s.get().generation).toBe("login-b");
  expect(s.get().tokens).not.toBeNull();

  const empty = store();

  empty.set({ generation: "empty", tokens: null });

  const c = await createClient(options(empty));

  expect(c.session.getSnapshot().status).toBe("signedOut");

  await expect(c.files.info("cloudreve://my/a")).rejects.toMatchObject({
    kind: "authentication",
  });

  const expired = store();

  expired.set({
    generation: "expired",
    tokens: { ...token(), refreshExpiresAt: 0 },
  });

  expect((await createClient(options(expired))).session.getSnapshot().status).toBe("signedOut");
});

it("bounds the complete response body, credential wait and safe retries without replaying mutations", async () => {
  const stalled = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"code":0'));
      },
    }),
  );

  await expect(
    request(async () => stalled, "https://cloud.test", { timeoutMs: 15 }),
  ).rejects.toMatchObject({ kind: "timeout" });

  const s = store();

  s.store.read = () => new Promise(() => {});

  await expect(
    new AccountClient({ ...options(s), timeoutMs: 15 }).request("/api/v4/file"),
  ).rejects.toMatchObject({ kind: "timeout" });

  let calls = 0;

  server.use(
    http.get("https://cloud.test/read", () =>
      ++calls < 2
        ? new HttpResponse("", { status: 503, headers: { "Retry-After": "0" } })
        : HttpResponse.json({ code: 0, data: 42 }),
    ),
    http.post("https://cloud.test/write", () => {
      calls++;

      return new HttpResponse("", { status: 503 });
    }),
  );

  expect(await request(fetch, "https://cloud.test/read")).toBe(42);
  expect(calls).toBe(2);

  await expect(
    request(fetch, "https://cloud.test/write", { method: "POST", body: "{}" }),
  ).rejects.toMatchObject({ httpStatus: 503 });

  expect(calls).toBe(3);
});

it("derives consistent token lifetimes and rejects malformed token/checkpoint primitives", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seconds) => {
      const result = tokensFromOAuth(
        {
          access_token: "a",
          refresh_token: "r",
          token_type: "Bearer",
          expires_in: seconds,
          refresh_token_expires_in: seconds + 1,
          scope: "",
        },
        1000,
      );

      expect(result.accessExpiresAt).toBe(1000 + seconds * 1000);
      expect(result.refreshExpiresAt - result.accessExpiresAt).toBe(1000);
    }),
  );

  expect(tokensFromPassword(replacement()).accessToken).toBe("new");
});

it("binds expected generations before asynchronous readiness and never acquires a newer identity on logout", async () => {
  const s = store();
  const stale = new AccountClient({ ...options(s), generation: "previous" });

  await expect(stale.ready()).rejects.toMatchObject({ kind: "authentication" });
  await stale.logout();
  expect(s.get().tokens).not.toBeNull();

  const unready = new AccountClient(options(s));

  await unready.logout();
  expect(s.get().tokens).not.toBeNull();

  const invalid = new AccountClient({
    ...options(s),
    store: {
      read: async () => {
        throw Error("vault locked");
      },
      write: async () => {},
    },
  });

  await expect(invalid.ready()).rejects.toMatchObject({ kind: "storage" });
  expect(() => new AccountClient({ ...options(s), exclusive: undefined })).toThrow("exclusive");

  expect(
    () =>
      new AccountClient({
        endpoint: "https://cloud.test",
        accountId: "u",
        transport: fetch,
      }),
  ).toThrow("store");
});

it("normalizes malformed JSON and HTTP envelope details and caps body consumption", async () => {
  await expect(
    request(async () => new Response("not json"), "https://s", {
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ kind: "validation" });

  await expect(
    request(
      async () =>
        HttpResponse.json(
          {
            code: 40020,
            msg: "Expired",
            correlation_id: "c",
            data: { partial: 1 },
            aggregated_error: { x: 403 },
          },
          { status: 403 },
        ),
      "https://s",
      { maxRetries: 0 },
    ),
  ).rejects.toMatchObject({
    kind: "http",
    httpStatus: 403,
    apiCode: 40020,
    correlationId: "c",
    data: { partial: 1 },
    aggregatedError: { x: 403 },
  });

  await expect(
    request(async () => new Response("x".repeat(8 * 1024 * 1024 + 1)), "https://s"),
  ).rejects.toThrow("byte limit");

  const error = await request(
    async () => new Response("x".repeat(5000), { status: 400 }),
    "https://s",
    {},
    true,
  ).catch((e) => e);

  expect(error.message).toHaveLength(4096);

  for (const timeoutMs of [-1, Infinity]) {
    await expect(request(fetch, "https://s", { timeoutMs })).rejects.toThrow("timeout");
  }

  for (const maxRetries of [-1, 6, 1.5]) {
    await expect(request(fetch, "https://s", { maxRetries })).rejects.toThrow("retry");
  }
});

it("retries only explicit safe replayable bodies and cancels retry backoff", async () => {
  const network = vi
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValue(HttpResponse.json({ code: 0, data: "ok" }));

  expect(
    await request(network, "https://s", {
      retry: "safe",
      method: "POST",
      body: "{}",
      replayable: true,
    }),
  ).toBe("ok");

  expect(network).toHaveBeenCalledTimes(2);

  for (const init of [
    { retry: "never" as const },
    { retry: "safe" as const, replayable: false },
    { maxRetries: 0 },
  ]) {
    const fails = vi.fn(async () => {
      throw Error("offline");
    });

    await expect(request(fails, "https://s", init)).rejects.toMatchObject({
      kind: "transport",
    });

    expect(fails).toHaveBeenCalledOnce();
  }

  await expect(
    request(
      async () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      "https://s",
      { timeoutMs: 15 },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });
});

it("iterates all pages, stops on consumer return and rejects cyclic cursors", async () => {
  const s = store();

  s.set({
    generation: "g",
    tokens: { ...token(), accessExpiresAt: Date.now() + 600000 },
  });

  let count = 0;

  const transport = vi.fn(async () =>
    HttpResponse.json({
      code: 0,
      data: {
        files: [
          {
            id: String(count),
            name: "f",
            path: "cloudreve://my/f",
            type: 0,
            size: 0,
          },
        ],
        pagination: { page: count++, page_size: 1, total_items: 2 },
        props: {},
      },
    }),
  );

  const c = await createClient({
    ...options(s),
    transport,
    storageTransport: transport,
    downloadTransport: transport,
  });

  const files = [];

  for await (const f of c.files.iterate("cloudreve://my/")) {
    files.push(f);
  }

  expect(files).toHaveLength(2);
  count = 0;

  for await (const _f of c.files.iterate("cloudreve://my/")) {
    break;
  }

  expect(count).toBe(1);

  const cycle = await createClient({
    ...options(s),
    transport: async () =>
      HttpResponse.json({
        code: 0,
        data: {
          files: [],
          pagination: { page: 0, page_size: 1, next_token: "same" },
          props: {},
        },
      }),
  });

  await expect(async () => {
    for await (const _f of cycle.files.iterate("cloudreve://my/")) {
      /* Drain pages. */
    }
  }).rejects.toThrow("pagination");
});

it("persists asynchronous queue transitions before publishing and serializes competing inserts", async () => {
  const { UploadQueue } = await import("@cloudreve/sdk/transfers");
  const pending: Array<() => void> = [];

  const q = new UploadQueue([], {
    save: () => new Promise<void>((resolve) => pending.push(resolve)),
    source: vi.fn(),
    uploads: vi.fn(),
  });

  const job = {
    id: "a",
    name: "a",
    source: "source",
    loaded: 0,
    status: "paused" as const,
    checkpoint: { accountId: "u", completed: true },
  } as any;

  const a = q.add(job);
  const b = q.add({ ...job, id: "b" });

  expect(q.getSnapshot()).toEqual([]);
  pending.shift()!();
  await a;
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(q.getSnapshot()).toHaveLength(1);
  pending.shift()!();
  await b;
  expect(q.getSnapshot()).toHaveLength(2);

  const remove = q.remove("a");

  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()!();
  await remove;
  expect(q.getSnapshot().map((j) => j.id)).toEqual(["b"]);

  const failed = new UploadQueue([], {
    save: async () => {
      throw Error("disk full");
    },
    source: vi.fn(),
    uploads: vi.fn(),
  });

  await expect(failed.add(job)).rejects.toThrow("disk full");
  expect(failed.getSnapshot()).toEqual([]);
});

it("accepts the exact expected generation and distinguishes durable logout failures from revocation failures", async () => {
  const s = store();
  const matching = new AccountClient({ ...options(s), generation: "login-a" });

  await matching.ready();
  expect(matching.getSnapshot().generation).toBe("login-a");
  expect(matching.getSnapshot().status).toBe("authenticated");

  s.store.write = async () => {
    throw Error("vault failed");
  };

  await expect(matching.logout()).rejects.toMatchObject({ kind: "storage" });
  expect(s.get().tokens).not.toBeNull();

  const independent = store();

  const c = new AccountClient({
    ...options(independent),
    transport: async () => new Response("", { status: 503 }),
  });

  await c.ready();

  await expect(c.logout({ revoke: true })).rejects.toMatchObject({
    kind: "http",
    httpStatus: 503,
  });

  expect(independent.get().tokens).toBeNull();
});

it("respects Retry-After dates and preserves sessions after transient refresh failure", async () => {
  let calls = 0;

  expect(
    await request(
      async () =>
        ++calls === 1
          ? new Response("", {
              status: 503,
              headers: { "Retry-After": new Date(0).toUTCString() },
            })
          : HttpResponse.json({ code: 0, data: 1 }),
      "https://s",
    ),
  ).toBe(1);

  const s = store();

  const c = new AccountClient({
    ...options(s),
    transport: async () => {
      throw Error("offline");
    },
  });

  await expect(c.request("/api/v4/file")).rejects.toMatchObject({
    kind: "transport",
  });

  expect(c.getSnapshot().status).toBe("authenticated");
  expect(s.get().tokens?.refreshToken).toBe("refresh");

  const expired = store();

  expired.set({ generation: "g", tokens: { ...token(), refreshExpiresAt: 0 } });

  const e = new AccountClient(options(expired));

  await expect(e.request("/api/v4/file")).rejects.toMatchObject({
    kind: "authentication",
  });

  expect(e.getSnapshot().status).toBe("signedOut");
});

it("supports uniform resource options and observes external session invalidation without UI token ownership", async () => {
  const s = store();

  s.set({
    generation: "g",
    tokens: { ...token(), accessExpiresAt: Date.now() + 600000 },
  });

  const c = await createClient({
    ...options(s),
    transport: async () => new Promise(() => {}),
  });

  await expect(c.account.me({ timeoutMs: 15 })).rejects.toMatchObject({
    kind: "timeout",
  });

  const changed = await createClient(options(s));

  s.set({ generation: "new-login", tokens: token() });

  await expect(changed.account.me()).rejects.toMatchObject({
    kind: "authentication",
  });

  expect(changed.session.getSnapshot().status).toBe("invalidated");

  const rejected = store();
  let requestCount = 0;

  const denied = new AccountClient({
    ...options(rejected),
    transport: async (url) =>
      url.endsWith("/refresh")
        ? HttpResponse.json({ code: 0, data: replacement() })
        : (requestCount++, HttpResponse.json({ code: 401, msg: "revoked" })),
  });

  await expect(denied.request("/api/v4/file")).rejects.toMatchObject({
    code: 401,
  });

  expect(denied.getSnapshot().status).toBe("signedOut");
  expect(requestCount).toBe(2);
});

it("bounds explicitly budgeted transfers without imposing a total duration limit by default", async () => {
  const { Uploads, Downloads } = await import("@cloudreve/sdk/transfers");
  const s = store();

  s.set({
    generation: "g",
    tokens: { ...token(), accessExpiresAt: Date.now() + 600000 },
  });

  const c = new AccountClient({
    ...options(s),
    transport: async () =>
      HttpResponse.json({
        code: 0,
        data: { urls: [{ url: "https://storage.test/file" }] },
      }),
  });

  const checkpoint = {
    accountId: "u",
    endpoint: "https://cloud.test",
    uri: "cloudreve://my/f",
    entity: "e",
    name: "f",
    size: 1,
    completed: false,
  };

  const sink = {
    size: () => 0,
    reset: async () => {},
    append: async () => {},
    close: async () => {},
  };

  const d = new Downloads(c, async () => new Response(new ReadableStream()));

  await expect(
    d.run(
      checkpoint,
      sink,
      async () => {},
      () => {},
      new AbortController().signal,
      { timeoutMs: 15 },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });

  const u = new Uploads(c, fetch);

  const job = {
    accountId: "u",
    endpoint: c.endpoint,
    spec: { uri: checkpoint.uri, size: 1, policy_id: "p" },
    provider: "local",
    session: {
      session_id: "s",
      uri: checkpoint.uri,
      expires: Date.now() / 1000 + 60,
      chunk_size: 1,
      upload_urls: [],
      credential: "",
      completeURL: "",
      callback_secret: "",
    },
    parts: [],
    completed: false,
  } as const;

  await expect(
    u.run(
      job as any,
      { size: 1, chunk: async () => new Promise(() => {}) },
      async () => {},
      () => {},
      new AbortController().signal,
      { timeoutMs: 15 },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });

  const done = { ...checkpoint, completed: true, size: 0 };

  expect(
    (
      await d.run(
        done,
        sink,
        async () => {},
        () => {},
        new AbortController().signal,
        { timeoutMs: 0 },
      )
    ).completed,
  ).toBe(true);

  expect(
    (
      await u.run(
        { ...job, completed: true } as any,
        { size: 1, chunk: vi.fn() },
        async () => {},
        () => {},
        new AbortController().signal,
        { timeoutMs: 0 },
      )
    ).completed,
  ).toBe(true);
});

it("keeps local-phase timeouts distinguishable and preserves generation tombstones", async () => {
  const s = store();

  const c = new AccountClient({
    ...options(s),
    generation: "login-a",
    timeoutMs: 15,
    exclusive: async () => new Promise(() => {}),
  });

  await expect(c.logout()).rejects.toMatchObject({
    kind: "storage",
    phase: "persistence",
  });

  expect(s.get().tokens).not.toBeNull();

  const cleared = store();

  cleared.set({ generation: "g", tokens: null });

  const empty = await createClient({ ...options(cleared), generation: "g" });

  await empty.session.logout({ revoke: true });
  expect(cleared.get()).toEqual({ generation: "g", tokens: null });
});

it("rejects malformed resource collections and repeated remote cursors through resource interfaces", async () => {
  const s = store();

  s.set({
    generation: "g",
    tokens: { ...token(), accessExpiresAt: Date.now() + 600000 },
  });

  let data: any = { shares: {}, pagination: {} };

  const c = await createClient({
    ...options(s),
    transport: async () => HttpResponse.json({ code: 0, data }),
  });

  await expect(c.shares.list()).rejects.toThrow("share list");

  for (const share of [
    { id: 3, visited: 0, url: "https://s" },
    { id: "s", visited: "0", url: "https://s" },
  ]) {
    data = { shares: [share], pagination: {} };
    await expect(c.shares.list()).rejects.toThrow("share response");
  }

  data = { accounts: [], pagination: { next_token: "same" } };
  await expect(c.webdav.get("missing")).rejects.toThrow("pagination");
  data = { tasks: [], pagination: { next_token: "same" } };
  await expect(c.jobs.get("missing", "create_archive")).rejects.toThrow("pagination");
});

it("supports mutation options without allowing unsafe retry overrides", async () => {
  const s = store();

  s.set({
    generation: "g",
    tokens: { ...token(), accessExpiresAt: Date.now() + 600000 },
  });

  const calls: RequestInit[] = [];

  const c = await createClient({
    ...options(s),
    transport: async (_url, init) => {
      calls.push(init!);

      return new Response("", { status: 503 });
    },
  });

  await expect(
    c.files.create("cloudreve://my/", "new", "file", {
      retry: "safe",
      maxRetries: 3,
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({ httpStatus: 503 });

  expect(calls).toHaveLength(1);

  const aborted = new AbortController();

  aborted.abort();

  const actions = [
    () => c.files.metadata(["cloudreve://my/f"], [], aborted.signal),
    () => c.files.unlock(["t"], aborted.signal),
    () => c.files.emptyTrash(aborted.signal),
    () => c.files.rename("cloudreve://my/f", "x", aborted.signal),
    () => c.files.move(["cloudreve://my/f"], "cloudreve://my/", false, aborted.signal),
    () => c.files.delete(["cloudreve://my/f"], false, aborted.signal),
    () => c.files.restore(["cloudreve://trash/f"], aborted.signal),
    () => c.shares.revoke("s", aborted.signal),
    () => c.shares.revokeDirect("d", aborted.signal),
    () => c.webdav.revoke("d", aborted.signal),
    () => c.account.password("abcd", "123456", aborted.signal),
  ];

  for (const action of actions) {
    await expect(action()).rejects.toMatchObject({ kind: "cancelled" });
  }

  expect(calls).toHaveLength(1);
});
