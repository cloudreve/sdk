import { describe, it, expect } from "vitest";
import { AccountClient } from "@cloudreve/sdk/session";
import {
  Uploads,
  parseUploadSession,
  type UploadCheckpoint,
  type UploadSource,
} from "@cloudreve/sdk/transfers";

const session = {
  session_id: "s",
  uri: "cloudreve://my/test",
  chunk_size: 2,
  expires: Date.now() / 1000 + 3600,
  upload_urls: ["https://storage.test/one", "https://storage.test/two"],
  completeURL: "https://storage.test/finish",
  callback_secret: "secret",
};

const ok = (data: unknown = null) => Response.json({ code: 0, data });

function client(transport: (url: string, init?: RequestInit) => Promise<Response>) {
  return new AccountClient({
    accountId: "one",
    endpoint: "https://cloud.test",
    transport,
    tokens: () => ({
      accessToken: "account-token",
      refreshToken: "refresh",
      accessExpiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    }),
    saveTokens: () => {},
  });
}

const source: UploadSource = {
  size: 4,
  chunk: async (start, end) => ({
    body: new Blob(["abcd".slice(start, end)]),
    dispose: async () => {},
  }),
};

describe("upload checkpoints and storage isolation", () => {
  it("renews elapsed sessions after placeholder cleanup without enabling overwrite", async () => {
    let creates = 0;

    const uploads = new Uploads(
      client(async (_url, init) => {
        if (init?.method === "DELETE") {
          return Response.json({ code: 40016, msg: "Missing placeholder" });
        }

        if (init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).not.toHaveProperty("entity_type");

          return ok({ ...session, session_id: String(++creates) });
        }

        return ok();
      }),
      async () => ok(),
    );

    const spec = {
      uri: session.uri,
      size: 4,
      policy_id: "p",
    };

    const job = await uploads.create(spec, "local");

    job.session.expires = 1;

    expect(
      (
        await uploads.run(
          job,
          source,
          async () => {},
          () => {},
          new AbortController().signal,
        )
      ).completed,
    ).toBe(true);

    expect(creates).toBe(2);
  });

  it("does not renew a lost session after cancellation", async () => {
    const controller = new AbortController();
    let mutations = 0;

    const uploads = new Uploads(
      client(async (_url, init) => {
        if (init?.method === "PUT") {
          mutations++;

          return ok(session);
        }

        if (init?.method === "DELETE") {
          mutations++;
        }

        controller.abort();

        return Response.json({ code: 40011 });
      }),
      async () => ok(),
    );

    const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "local");

    await expect(
      uploads.run(
        job,
        source,
        async () => {},
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(mutations).toBe(1);
  });

  it("restarts a server-lost session from zero and persists it before sending bytes", async () => {
    let created = 0;
    const calls: string[] = [];
    let saved: UploadCheckpoint;

    const uploads = new Uploads(
      client(async (url, init) => {
        calls.push(`${init?.method} ${url.split("/").slice(-2).join("/")}`);

        if (init?.method === "DELETE") {
          expect(JSON.parse(String(init.body)).id).toBe("s");

          return ok();
        }

        if (init?.method === "PUT") {
          return ok({ ...session, session_id: created++ ? "new" : "s" });
        }

        if (url.includes("/s/")) {
          return Response.json({ code: 40011 });
        }

        expect(saved.session.session_id).toBe("new");

        return ok();
      }),
      async () => {
        throw new Error("Unexpected storage call");
      },
    );

    saved = {
      ...(await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "local")),
      parts: [""],
    };

    await uploads.run(
      saved,
      source,
      async (next) => {
        saved = next;
      },
      () => {},
      new AbortController().signal,
    );

    expect(saved.completed).toBe(true);

    expect(calls).toEqual([
      "PUT file/upload",
      "POST s/1",
      "DELETE file/upload",
      "PUT file/upload",
      "POST new/0",
      "POST new/1",
    ]);
  });

  it("bounds expired-session recovery and cancels a replacement that cannot be persisted", async () => {
    for (const persistenceFails of [false, true]) {
      let creates = 0;
      const deleted: string[] = [];

      const uploads = new Uploads(
        client(async (_url, init) => {
          if (init?.method === "PUT") {
            return ok({ ...session, session_id: creates++ ? "new" : "s" });
          }

          if (init?.method === "DELETE") {
            deleted.push(JSON.parse(String(init.body)).id);

            return ok();
          }

          return Response.json({ code: 40011, msg: "Expired" });
        }),
        async () => ok(),
      );

      const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "local");

      await expect(
        uploads.run(
          job,
          source,
          async () => {
            if (persistenceFails) {
              throw new Error("Disk full");
            }
          },
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow(persistenceFails ? "Disk full" : "Expired");

      expect(creates).toBe(2);
      expect(deleted).toEqual(persistenceFails ? ["s", "new"] : ["s"]);
    }
  });

  it("resumes only acknowledged chunks and saves before completion", async () => {
    const calls: string[] = [];
    let fail = true;

    const uploads = new Uploads(
      client(async (url) => {
        calls.push(url);

        if (url.endsWith("/upload")) {
          return ok(session);
        }

        if (url.endsWith("/1") && fail) {
          throw new Error("Disconnected");
        }

        return ok();
      }),
      async () => {
        throw new Error("Unexpected storage request");
      },
    );

    let saved = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "local");

    const save = async (next: UploadCheckpoint) => {
      saved = next;
    };

    await expect(
      uploads.run(saved, source, save, () => {}, new AbortController().signal),
    ).rejects.toThrow("Disconnected");

    expect(saved.parts).toEqual([""]);
    fail = false;
    await uploads.run(saved, source, save, () => {}, new AbortController().signal);
    expect(saved.completed).toBe(true);
    expect(calls.filter((url) => url.endsWith("/0"))).toHaveLength(1);
  });

  it("never forwards account authorization to storage and escapes completion XML", async () => {
    const uploads = new Uploads(
      client(async () => ok(session)),
      async (_url, init) => {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        expect(init?.redirect).toBe("error");

        if (init?.method === "POST") {
          expect(init.body).toContain("&quot;part&amp;1&quot;");
        }

        return new Response("", { headers: { etag: '"part&1"' } });
      },
    );

    const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "s3");

    expect(
      (
        await uploads.run(
          job,
          source,
          async () => {},
          () => {},
          new AbortController().signal,
        )
      ).completed,
    ).toBe(true);
  });

  it("rejects wrong-account recovery, malformed sessions and embedded completion errors", async () => {
    expect(() => parseUploadSession({ ...session, chunk_size: -1 })).toThrow();
    expect(() => parseUploadSession({ ...session, upload_urls: ["file:///secret"] })).toThrow();

    const uploads = new Uploads(
      client(async () => ok(session)),
      async (_url, init) =>
        new Response(init?.method === "POST" ? "<Error><Code>InvalidPart</Code></Error>" : "", {
          headers: { etag: "e" },
        }),
    );

    const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "s3");

    await expect(
      uploads.run(
        { ...job, accountId: "other" },
        source,
        async () => {},
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("another account");

    await expect(
      uploads.run(
        job,
        source,
        async () => {},
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("multipart completion");
  });

  it("disposes a prepared chunk when cancelled without acknowledging it", async () => {
    const uploads = new Uploads(
      client(async () => ok(session)),
      async () => ok(),
    );

    const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "local");
    const controller = new AbortController();
    let disposed = false;
    let persisted = false;

    await expect(
      uploads.run(
        job,
        {
          size: 4,
          chunk: async () => {
            controller.abort();

            return {
              body: "ab",
              dispose: async () => {
                disposed = true;
              },
            };
          },
        },
        async () => {
          persisted = true;
        },
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(disposed).toBe(true);
    expect(persisted).toBe(false);
  });
});

it("account invalidation cancels a signed-storage request before a late acknowledgement", async () => {
  let sawAbort = false;
  const account = client(async () => ok(session));

  const uploads = new Uploads(account, async (_url, init) => {
    init?.signal?.addEventListener("abort", () => {
      sawAbort = true;
    });

    account.invalidate();

    return new Response("", { headers: { etag: "late" } });
  });

  const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "s3");
  let saved = false;

  await expect(
    uploads.run(
      job,
      source,
      async () => {
        saved = true;
      },
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("cancelled");

  expect(sawAbort).toBe(true);
  expect(saved).toBe(false);
});

it("aligns OneDrive recovery to the remote byte offset and completes the server callback", async () => {
  const callbacks: string[] = [];
  const ranges: number[][] = [];

  const uploads = new Uploads(
    client(async (url, init) => {
      if (url.includes("/callback/")) {
        expect(init?.method).toBe("POST");
        callbacks.push(url);

        return ok();
      }

      return ok(session);
    }),
    async (_url, init) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);

      if (init?.method === "GET") {
        return Response.json({ nextExpectedRanges: ["3-"] });
      }

      expect(new Headers(init?.headers).get("Content-Range")).toBe("bytes 3-3/4");

      return Response.json({ id: "remote-file" }, { status: 201 });
    },
  );

  const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "onedrive");

  const source: UploadSource = {
    size: 4,
    chunk: async (start, end) => {
      ranges.push([start, end]);

      return { body: "d", dispose: async () => {} };
    },
  };

  const result = await uploads.run(
    job,
    source,
    async () => {},
    () => {},
    new AbortController().signal,
  );

  expect(result.completed).toBe(true);
  expect(ranges).toEqual([[3, 4]]);
  expect(callbacks).toHaveLength(1);
});

it("uploads Upyun as one multipart file with provider credentials, never account credentials", async () => {
  const chunks: number[][] = [];

  const uploads = new Uploads(
    client(async () =>
      ok({
        ...session,
        upload_policy: "signed-policy",
        credential: "provider-signature",
        mime_type: "text/plain",
      }),
    ),
    async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);

      const form = init?.body as FormData;

      expect([...form.keys()]).toEqual(["policy", "authorization", "content-type", "file"]);
      expect(form.get("authorization")).toBe("provider-signature");

      return Response.json({ code: 200 });
    },
  );

  const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "upyun");

  const source: UploadSource = {
    size: 4,
    chunk: async (start, end) => {
      chunks.push([start, end]);

      return {
        body: "",
        multipart: (fields, filename, mime) => {
          const form = new FormData();

          Object.entries(fields).forEach(([k, v]) => form.append(k, v));
          form.append("file", new Blob(["data"], { type: mime }), filename);

          return form;
        },
        dispose: async () => {},
      };
    },
  };

  expect(
    (
      await uploads.run(
        job,
        source,
        async () => {},
        () => {},
        new AbortController().signal,
      )
    ).completed,
  ).toBe(true);

  expect(chunks).toEqual([[0, 4]]);
});

it("uses authenticated local upload when the server enables relay", async () => {
  const uploads = new Uploads(
    client(async (url) =>
      url.endsWith("/upload") ? ok({ ...session, storage_policy: { relay: true } }) : ok(),
    ),
    async () => {
      throw new Error("Must not upload directly");
    },
  );

  const job = await uploads.create({ uri: session.uri, size: 4, policy_id: "p" }, "s3");

  expect(job.provider).toBe("local");

  expect(
    (
      await uploads.run(
        job,
        source,
        async () => {},
        () => {},
        new AbortController().signal,
      )
    ).completed,
  ).toBe(true);
});
