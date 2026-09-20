import { expect, it, vi } from "vitest";
import { AccountClient } from "@cloudreve/sdk/session";
import {
  Uploads,
  selectUploadPolicy,
  parseUploadSession,
  uploadProviders,
  type UploadProvider,
  type UploadSource,
  type UploadSession,
} from "@cloudreve/sdk/transfers";

const ok = (data: unknown = null) => Response.json({ code: 0, data });

const spec = {
  uri: "cloudreve://my/file.txt",
  size: 5,
  policy_id: "leaf",
  mime_type: "requested/type",
  last_modified: 0,
};

const base = (): UploadSession => ({
  session_id: "session",
  uri: spec.uri,
  expires: Date.now() / 1000 + 3600,
  chunk_size: 2,
  upload_urls: [
    "https://storage.test/part1",
    "https://storage.test/part2",
    "https://storage.test/part3",
  ],
  completeURL: "https://storage.test/finish",
  callback_secret: "callback",
  credential: "provider-secret",
  mime_type: "session/type",
  upload_policy: "signed-policy",
});

function fixture(
  provider: UploadProvider,
  session = base(),
  storage?: (url: string, init: RequestInit) => Promise<Response>,
  api?: (url: string, init: RequestInit) => Promise<Response>,
) {
  const requests: { url: string; init: RequestInit }[] = [];

  const account = new AccountClient({
    accountId: "a",
    endpoint: "https://cloud.test",
    transport: async (url, init = {}) => {
      requests.push({ url, init });

      return api
        ? api(url, init)
        : url.endsWith("/upload") && init.method === "PUT"
          ? ok(session)
          : ok();
    },
    tokens: () => ({
      accessToken: "account-only",
      refreshToken: "refresh",
      accessExpiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    }),
    saveTokens: () => {},
  });

  const external = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).not.toBe("Bearer account-only");

    return storage
      ? storage(url, init)
      : init.method === "GET"
        ? Response.json({ nextExpectedRanges: ["0-"] })
        : provider === "qiniu" && init.method === "PUT"
          ? Response.json({ etag: "tag" })
          : provider === "remote" || provider === "qiniu"
            ? ok()
            : new Response("", { headers: { etag: '"tag"' } });
  });

  const chunks: number[][] = [];
  const dispose = vi.fn(async () => {});

  const source: UploadSource = {
    size: 5,
    chunk: async (start, end, _encryption, progress) => {
      chunks.push([start, end]);
      progress(-10);
      progress(100);

      return {
        body: new Blob(["abcde".slice(start, end)]),
        dispose,
        multipart: (fields, name, mime) => {
          const form = new FormData();

          Object.entries(fields).forEach(([key, value]) => form.set(key, value));
          form.set("file", new Blob(["abcde"], { type: mime }), name);

          return form;
        },
      };
    },
  };

  const uploads = new Uploads(account, (url, init) => external(url, init ?? {}));
  const saved: unknown[] = [];

  const run = async () =>
    uploads.run(
      await uploads.create(spec, provider),
      source,
      async (next) => {
        saved.push(next);
      },
      () => {},
      new AbortController().signal,
    );

  return {
    uploads,
    account,
    external,
    requests,
    source,
    chunks,
    dispose,
    saved,
    run,
  };
}

it.each(uploadProviders)(
  "%s uploads uneven chunks with its own completion/authentication contract",
  async (provider) => {
    const f = fixture(provider);
    const result = await f.run();

    expect(result.completed).toBe(true);

    expect(f.chunks).toEqual(
      provider === "upyun"
        ? [[0, 5]]
        : [
            [0, 2],
            [2, 4],
            [4, 5],
          ],
    );

    expect(f.dispose).toHaveBeenCalledTimes(f.chunks.length);

    const calls = f.external.mock.calls;
    const callbacks = f.requests.filter((x) => x.url.includes("/callback/"));

    expect(callbacks.length).toBe(["s3", "cos", "ks3", "onedrive"].includes(provider) ? 1 : 0);

    if (callbacks.length) {
      expect(callbacks[0]!.url).toContain(`/callback/${provider}/session/callback`);
      expect(callbacks[0]!.init.method ?? "GET").toBe(provider === "onedrive" ? "POST" : "GET");
    }

    if (provider === "local") {
      expect(calls).toHaveLength(0);
      expect(f.requests.slice(1).map((x) => x.url.split("/").at(-1))).toEqual(["0", "1", "2"]);
    }

    if (provider === "remote") {
      expect(calls.map(([u]) => new URL(u).searchParams.get("chunk"))).toEqual(["0", "1", "2"]);
      expect(new Headers(calls[0]![1].headers).get("Authorization")).toBe("provider-secret");
    }

    if (["s3", "cos", "ks3", "oss", "obs"].includes(provider)) {
      const [, finish] = calls.at(-1)!;
      const h = new Headers(finish.headers);

      expect(finish.method).toBe("POST");
      expect(h.get("x-cos-forbid-overwrite")).toBe(provider === "cos" ? "true" : null);
      expect(h.get("x-oss-complete-all")).toBe(provider === "oss" ? "yes" : null);
      expect(h.get("x-oss-forbid-overwrite")).toBe(provider === "oss" ? "true" : null);

      expect(String(finish.body)).toBe(
        provider === "oss"
          ? ""
          : "<CompleteMultipartUpload>" +
              [1, 2, 3]
                .map(
                  (i) => `<Part><PartNumber>${i}</PartNumber><ETag>&quot;tag&quot;</ETag></Part>`,
                )
                .join("") +
              "</CompleteMultipartUpload>",
      );
    }

    if (provider === "qiniu") {
      expect(calls.slice(0, 3).map(([u]) => u.split("/").at(-1))).toEqual(["1", "2", "3"]);

      expect(JSON.parse(String(calls.at(-1)![1].body))).toEqual({
        mimeType: "session/type",
        parts: [1, 2, 3].map((partNumber) => ({ etag: "tag", partNumber })),
      });
    }

    if (provider === "upyun") {
      const form = calls[0]![1].body as FormData;

      expect(form.get("policy")).toBe("signed-policy");
      expect(form.get("authorization")).toBe("provider-secret");
      expect(form.get("content-type")).toBe("session/type");
      expect(await (form.get("file") as File).text()).toBe("abcde");
    }

    if (provider === "onedrive") {
      expect(
        calls
          .filter(([, i]) => i.method === "PUT")
          .map(([, i]) => new Headers(i.headers).get("Content-Range")),
      ).toEqual(["bytes 0-1/5", "bytes 2-3/5", "bytes 4-4/5"]);
    }
  },
);

it("OSS accepts absent ETag because complete-all owns part collection", async () => {
  expect((await fixture("oss", base(), async () => new Response("")).run()).completed).toBe(true);
});

it.each(["remote", "qiniu"] as const)(
  "%s rejects HTTP200 backend errors without recording completion",
  async (p) => {
    const f = fixture(p, base(), async (_u, i) =>
      p === "qiniu" && i.method === "PUT"
        ? Response.json({ etag: "e" })
        : Response.json({ code: 40001, msg: "Callback rejected" }),
    );

    await expect(f.run()).rejects.toThrow("Callback rejected");
    expect(f.saved.some((x: any) => x.completed)).toBe(false);
  },
);

it.each(["s3", "cos", "ks3", "oss", "obs", "qiniu", "upyun", "remote"] as const)(
  "%s propagates storage HTTP errors and disposes source",
  async (p) => {
    const f = fixture(p, base(), async () => new Response("failure", { status: 500 }));

    await expect(f.run()).rejects.toThrow();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.saved).toHaveLength(0);
  },
);

it.each(["s3", "cos", "ks3", "obs", "qiniu"] as const)(
  "%s refuses a missing part acknowledgement",
  async (p) => {
    const f = fixture(p, base(), async () => Response.json({}));

    await expect(f.run()).rejects.toThrow();
    expect(f.saved).toHaveLength(0);
  },
);

it.each(["s3", "cos", "ks3", "oss", "obs"] as const)(
  "%s propagates completion HTTP failures without success",
  async (p) => {
    const f = fixture(p, base(), async (_u, i) =>
      i.method === "POST"
        ? new Response("", { status: 500 })
        : new Response("", { headers: { etag: "part" } }),
    );

    await expect(f.run()).rejects.toThrow();
    expect(f.saved).toHaveLength(3);
  },
);

it.each(["s3", "cos", "ks3", "onedrive"] as const)(
  "%s preserves complete parts if Cloudreve callback rejects",
  async (p) => {
    const s = base();

    const f = fixture(p, s, undefined, async (u, i) =>
      u.includes("/callback/")
        ? Response.json({ code: 40001, msg: "Callback failed" })
        : i.method === "PUT"
          ? ok(s)
          : ok(),
    );

    await expect(f.run()).rejects.toThrow("Callback failed");
    expect(f.saved).toHaveLength(3);
  },
);

it.each(["<Error>bad</Error>", '<?xml version="1.0"?><s3:Error code="x"/>', '<Error\nfoo="x"/>'])(
  "rejects embedded multipart errors: %s",
  async (body) => {
    const f = fixture(
      "s3",
      base(),
      async (_u, i) =>
        new Response(i.method === "POST" ? body : "", {
          headers: { etag: "tag" },
        }),
    );

    await expect(f.run()).rejects.toThrow("Storage rejected");
  },
);

it("selects weighted leaf policies at boundaries and rejects unusable parents", () => {
  const a = { id: "a", type: "s3", weight: 1 };
  const b = { id: "b", type: "remote", weight: 3 };

  const p = {
    id: "parent",
    type: "load_balance",
    children: [{ id: "disabled", type: "oss", weight: 0 }, a, b],
  };

  expect(selectUploadPolicy(a)).toEqual(a);
  expect(selectUploadPolicy(p, () => 0).id).toBe("a");
  expect(selectUploadPolicy(p, () => 0.249).id).toBe("a");
  expect(selectUploadPolicy(p, () => 0.25).id).toBe("b");
  expect(selectUploadPolicy(p, () => 0.999).id).toBe("b");

  for (const children of [
    undefined,
    [],
    [{ ...a, weight: 0 }],
    [{ ...a, weight: -1 }],
    [{ ...a, weight: Infinity }],
  ]) {
    expect(() => selectUploadPolicy({ ...p, children })).toThrow();
  }

  expect(() => selectUploadPolicy({ ...p, children: [{ ...a, type: "load_balance" }] })).toThrow();

  for (const random of [-1, 1, NaN]) {
    expect(() => selectUploadPolicy(p, () => random)).toThrow();
  }

  expect(() => selectUploadPolicy({ id: "", type: "local" })).toThrow();
});

it("uses server-selected provider and relay while retaining the chosen policy ID", async () => {
  for (const relay of [false, true]) {
    const s = { ...base(), storage_policy: { type: "oss", relay } };
    const f = fixture("s3", s);
    const job = await f.uploads.create(spec, "s3");

    expect(job.provider).toBe(relay ? "local" : "oss");
    expect(job.spec.policy_id).toBe("leaf");
  }

  expect(() => parseUploadSession({ ...base(), storage_policy: { type: "unknown" } })).toThrow();
});

it.each([0, 1, 2, 3, 5])(
  "handles local file size %i without skipping empty uploads",
  async (size) => {
    const f = fixture("local");

    f.source.size = size;

    const job = await f.uploads.create({ ...spec, size }, "local");

    await f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    );

    expect(f.chunks).toEqual(
      size === 0
        ? [[0, 0]]
        : Array.from({ length: Math.ceil(size / 2) }, (_, i) => [
            i * 2,
            Math.min(size, (i + 1) * 2),
          ]),
    );
  },
);

it("preserves a zero timestamp and rejects unsupported provider before requesting", async () => {
  const f = fixture("local");

  await f.uploads.create(spec, "local");
  expect(JSON.parse(String(f.requests[0]!.init.body)).last_modified).toBe(0);
  await expect(f.uploads.create(spec, "unknown" as UploadProvider)).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});

it.each([1, 2, 5])(
  "realigns OneDrive overlap to byte %i without resending acknowledged bytes",
  async (offset) => {
    let gets = 0;
    let puts = 0;

    const ranges: string[] = [];

    const f = fixture("onedrive", base(), async (_u, i) => {
      if (i.method === "GET") {
        return Response.json({
          nextExpectedRanges: [`${gets++ ? offset : 0}-`],
        });
      }

      ranges.push(new Headers(i.headers).get("Content-Range")!);

      return puts++ === 0
        ? Response.json({ error: { innererror: { code: "fragmentOverlap" } } }, { status: 416 })
        : Response.json({});
    });

    expect((await f.run()).completed).toBe(true);
    expect(gets).toBe(2);
    expect(f.chunks[0]).toEqual([0, 2]);

    if (offset === 1) {
      expect(ranges[1]).toBe("bytes 1-1/5");
    }

    if (offset === 2) {
      expect(ranges[1]).toBe("bytes 2-3/5");
    }

    if (offset === 5) {
      expect(puts).toBe(1);
    }

    expect(f.dispose).toHaveBeenCalledTimes(f.chunks.length);
  },
);

it("bounds OneDrive overlap retries and preserves the original failure when it is not overlap", async () => {
  for (const code of ["fragmentOverlap", "invalidRange"]) {
    let gets = 0;
    let puts = 0;

    const f = fixture("onedrive", base(), async (_u, i) =>
      i.method === "GET"
        ? Response.json({ nextExpectedRanges: [`${gets++ ? 1 : 0}-`] })
        : (puts++, Response.json({ error: { code } }, { status: 416 })),
    );

    await expect(f.run()).rejects.toThrow();
    expect(puts).toBe(code === "fragmentOverlap" ? 2 : 1);
    expect(f.saved).toHaveLength(0);
  }
});

it.each([
  undefined,
  [],
  ["0-", "2-"],
  [1],
  ["x-"],
  ["-1-"],
  ["6-"],
  ["0-99"],
  ["2-1"],
  ["9007199254740992-"],
  ["0-9007199254740992"],
])("rejects invalid OneDrive status range %j", async (ranges) => {
  const f = fixture("onedrive", base(), async () => Response.json({ nextExpectedRanges: ranges }));

  await expect(f.run()).rejects.toThrow();
  expect(f.chunks).toHaveLength(0);
});

it("accepts a bounded OneDrive range and skips remotely acknowledged chunks", async () => {
  const f = fixture("onedrive", base(), async () => Response.json({ nextExpectedRanges: ["4-4"] }));

  expect((await f.run()).completed).toBe(true);
  expect(f.chunks).toEqual([[4, 5]]);
});

it.each(["stale", "failed", "malformed"] as const)(
  "refuses OneDrive %s overlap reconciliation",
  async (mode) => {
    let gets = 0;

    const f = fixture("onedrive", base(), async (_u, i) =>
      i.method === "PUT"
        ? Response.json({ error: { code: "fragmentOverlap" } }, { status: 416 })
        : gets++ === 0
          ? Response.json({ nextExpectedRanges: ["0-"] })
          : mode === "failed"
            ? new Response("bad", { status: 503 })
            : mode === "malformed"
              ? Response.json({})
              : Response.json({ nextExpectedRanges: ["0-"] }),
    );

    await expect(f.run()).rejects.toThrow();
    expect(f.chunks).toHaveLength(1);
    expect(f.saved).toHaveLength(0);
  },
);

it.each(["GET", "PUT"])("renews a missing OneDrive session on %s exactly once", async (method) => {
  let gone = false;
  let creates = 0;
  let cancels = 0;

  const s = base();

  const f = fixture(
    "onedrive",
    s,
    async (_u, i) => {
      if (i.method === method && !gone) {
        gone = true;

        return new Response("", { status: 404 });
      }

      return i.method === "GET" ? Response.json({ nextExpectedRanges: ["0-"] }) : Response.json({});
    },
    async (_u, i) => {
      if (i.method === "DELETE") {
        cancels++;
      }

      if (i.method === "PUT") {
        creates++;
      }

      return i.method === "PUT" ? ok(s) : ok();
    },
  );

  expect((await f.run()).completed).toBe(true);
  expect(creates).toBe(2);
  expect(cancels).toBe(1);
});

it("rejects malformed overlap bodies and callback errors without hiding them", async () => {
  for (const body of [null, {}, { error: {} }, { error: { innererror: [] } }]) {
    const f = fixture("onedrive", base(), async (_u, i) =>
      i.method === "GET"
        ? Response.json({ nextExpectedRanges: ["0-"] })
        : Response.json(body, { status: 416 }),
    );

    await expect(f.run()).rejects.toThrow();
  }
});

it("rejects OneDrive empty files before allocating a session", async () => {
  const f = fixture("onedrive");

  await expect(f.uploads.create({ ...spec, size: 0 }, "onedrive")).rejects.toThrow("empty");
  expect(f.requests).toHaveLength(0);
});

it("does not require ETag or a new part after recovering all acknowledged bytes", async () => {
  const f = fixture("onedrive", base(), async () => Response.json({ nextExpectedRanges: ["5-"] }));

  expect((await f.run()).completed).toBe(true);
  expect(f.chunks).toHaveLength(0);
});

it("rejects a remote status that falls behind the durable checkpoint", async () => {
  const f = fixture("onedrive");
  const job = await f.uploads.create(spec, "onedrive");

  job.parts = [""];

  await expect(
    f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("differs");
});

it("uses whole-file chunking when the server supplies zero chunk size", async () => {
  const f = fixture("local", { ...base(), chunk_size: 0 });

  await f.run();
  expect(f.chunks).toEqual([[0, 5]]);
});

it("never acknowledges bytes when preparing/disposal/persistence fails", async () => {
  for (const step of ["chunk", "dispose", "save"]) {
    const f = fixture("local");
    const job = await f.uploads.create(spec, "local");
    const original = f.source.chunk;

    f.source.chunk = async (...args) => {
      if (step === "chunk") {
        throw new Error("Disk fault");
      }

      const chunk = await original(...args);

      return {
        ...chunk,
        dispose: async () => {
          if (step === "dispose") {
            throw new Error("Disk fault");
          }
        },
      };
    };

    const saved: unknown[] = [];

    await expect(
      f.uploads.run(
        job,
        f.source,
        async (j) => {
          if (step === "save") {
            throw new Error("Disk fault");
          }

          saved.push(j);
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("Disk fault");

    expect(saved).toHaveLength(0);
  }
});

it("rejects impossible part counts and returns completed jobs without another network request", async () => {
  const f = fixture("local");
  const job = await f.uploads.create(spec, "local");

  job.parts = ["", "", "", ""];

  await expect(
    f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("checkpoint");

  job.parts = [];
  job.completed = true;

  expect(
    await f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).toBe(job);

  expect(f.requests).toHaveLength(1);
});

it("propagates cancellation failures except an already-absent placeholder", async () => {
  for (const code of [40016, 403]) {
    const s = base();

    const f = fixture("local", s, undefined, async (_u, i) =>
      i.method === "DELETE" ? Response.json({ code, msg: "Denied" }) : ok(s),
    );

    const job = await f.uploads.create(spec, "local");

    if (code === 40016) {
      await f.uploads.cancel(job);
    } else {
      await expect(f.uploads.cancel(job)).rejects.toThrow("Denied");
    }
  }
});

it("cleans up abort listeners when the account was already invalidated", async () => {
  const f = fixture("s3");
  const job = await f.uploads.create(spec, "s3");

  f.account.invalidate();

  await expect(
    f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow();

  expect(f.external).not.toHaveBeenCalled();
});

it.each([
  { size: -1 },
  { size: 1.5 },
  { size: Infinity },
  { policy_id: "" },
  { uri: "https://other.test" },
])("rejects malformed upload specification %j", async (patch) => {
  const f = fixture("local");

  await expect(f.uploads.create({ ...spec, ...patch }, "local")).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it.each([
  { chunk_size: -1 },
  { chunk_size: 1.5 },
  { expires: NaN },
  { expires: "1" },
  { upload_urls: {} },
  { upload_urls: ["file:///tmp/x"] },
  { upload_urls: ["https://user:pass@storage.test/"] },
  { session_id: "" },
  { uri: "" },
  { encrypt_metadata: { algorithm: "unknown" } },
  {
    encrypt_metadata: {
      algorithm: "aes-256-ctr",
      key_plain_text: "bad",
      iv: "bad",
    },
  },
])("rejects malformed upload session %j", (patch) => {
  expect(() => parseUploadSession({ ...base(), ...patch })).toThrow();
});

it("accepts valid encryption metadata and passes it to every source range", async () => {
  const encrypt_metadata = {
    algorithm: "aes-256-ctr" as const,
    key_plain_text: Buffer.alloc(32).toString("base64"),
    iv: Buffer.alloc(16).toString("base64"),
  };

  const f = fixture("local", { ...base(), encrypt_metadata });
  const chunk = vi.spyOn(f.source, "chunk");

  await f.run();

  for (const args of chunk.mock.calls) {
    expect(args[2]).toEqual(encrypt_metadata);
  }

  expect(
    parseUploadSession({
      session_id: "s",
      uri: spec.uri,
      expires: 1,
      chunk_size: 0,
    }),
  ).toMatchObject({
    upload_urls: [],
    completeURL: "",
    credential: "",
    callback_secret: "",
  });
});

it("omits optional Upyun MIME and rejects unavailable multipart support", async () => {
  const s = { ...base(), mime_type: undefined };
  const f = fixture("upyun", s);

  const job = await f.uploads.create(
    { ...spec, mime_type: undefined, uri: "cloudreve://my/" },
    "upyun",
  );

  await f.uploads.run(
    job,
    f.source,
    async () => {},
    () => {},
    new AbortController().signal,
  );

  const form = f.external.mock.calls[0]![1].body as FormData;

  expect(form.has("content-type")).toBe(false);
  expect((form.get("file") as File).name).toBe("upload");
  f.source.chunk = async () => ({ body: "data", dispose: async () => {} });

  await expect(
    f.uploads.run(
      job,
      f.source,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("Multipart");
});
