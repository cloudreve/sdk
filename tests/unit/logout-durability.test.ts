import { it, expect } from "vitest";
import {
  AccountClient,
  createClient,
  type SessionRecord,
  type SessionExclusive,
} from "../../src/index.ts";
import { waitFor, assertNotAborted } from "@cloudreve/sdk/protocol";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => (resolve = ready));

  return { promise, resolve };
}

it("durably invalidates before lease timeout so cold restore rejects a late native refresh write", async () => {
  let raw: SessionRecord = {
    generation: "first",
    tokens: {
      accessToken: "old",
      refreshToken: "r",
      accessExpiresAt: 0,
      refreshExpiresAt: Date.now() + 60000,
    },
  };

  const invalid = new Set<string>();
  const started = deferred();
  const finish = deferred();
  const written = deferred();

  let tail = Promise.resolve();

  const exclusive: SessionExclusive = async (fn, signal) => {
    const previous = tail;
    const release = deferred();

    tail = previous.then(() => release.promise);

    try {
      await waitFor(previous, signal);
      assertNotAborted(signal);

      return await fn();
    } finally {
      release.resolve();
    }
  };

  const store = {
    read: async () => structuredClone(invalid.has(raw.generation) ? { ...raw, tokens: null } : raw),
    invalidate: async (generation: string) => {
      invalid.add(generation);
    },
    write: async (record: SessionRecord) => {
      if (record.tokens?.accessToken === "new") {
        started.resolve();
        await finish.promise;
      }

      raw = structuredClone(record);
      written.resolve();
    },
  };

  const transport = async () =>
    Response.json({
      code: 0,
      data: {
        access_token: "new",
        refresh_token: "new-r",
        access_expires: new Date(Date.now() + 600000).toISOString(),
        refresh_expires: new Date(Date.now() + 1200000).toISOString(),
      },
    });

  const options = {
    endpoint: "https://cloud.test",
    accountId: "u",
    store,
    exclusive,
    transport,
    generation: "first",
    timeoutMs: 60,
  };

  const c = new AccountClient(options);

  await c.ready();

  const request = c.request("/api/v4/file");
  const rejected = expect(request).rejects.toThrow();

  await started.promise;

  await expect(c.logout()).rejects.toMatchObject({
    kind: "storage",
    phase: "persistence",
  });

  expect(invalid.has("first")).toBe(true);
  await rejected;
  expect((await createClient(options)).session.getSnapshot().status).toBe("signedOut");
  finish.resolve();
  await written.promise;
  await exclusive(async () => {});
  expect(raw.tokens?.accessToken).toBe("new");
  expect((await createClient(options)).session.getSnapshot().status).toBe("signedOut");

  await exclusive(async () => {
    raw = {
      generation: "second",
      tokens: { ...raw.tokens!, accessExpiresAt: Date.now() + 600000 },
    };
  });

  expect(
    (await createClient({ ...options, generation: "second" })).session.getSnapshot().status,
  ).toBe("authenticated");
});

it("keeps remote revocation identity after the negative marker hides credentials", async () => {
  let record: SessionRecord = {
    generation: "g",
    tokens: {
      accessToken: "a",
      refreshToken: "must-revoke",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    },
  };

  let hidden = false;
  let body: unknown;

  const c = new AccountClient({
    endpoint: "https://cloud.test",
    accountId: "u",
    generation: "g",
    store: {
      read: async () => ({ ...record, tokens: hidden ? null : record.tokens }),
      invalidate: async () => {
        hidden = true;
      },
      write: async (next) => {
        record = next;
      },
    },
    exclusive: async (fn) => fn(),
    transport: async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ code: 0 });
    },
  });

  await c.ready();
  await c.logout({ revoke: true });
  expect(body).toEqual({ refresh_token: "must-revoke" });
  expect(record.tokens).toBeNull();
});

it("surfaces a failed durable negative marker without claiming successful persistence", async () => {
  const c = new AccountClient({
    endpoint: "https://cloud.test",
    accountId: "u",
    generation: "g",
    store: {
      read: async () => ({ generation: "g", tokens: null }),
      invalidate: async () => {
        throw Error("marker disk full");
      },
      write: async () => {
        throw Error("Must not write");
      },
    },
    exclusive: async (fn) => fn(),
    transport: async () => {
      throw Error("No network");
    },
  });

  await expect(c.logout()).rejects.toMatchObject({
    kind: "storage",
    phase: "persistence",
    message: "marker disk full",
  });
});
