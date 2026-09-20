import type { Transport } from "../../src/protocol/index";
import { describe, it, expect, vi } from "vitest";
import { AccountClient, type Tokens } from "../../src/session/index";
import { childUri } from "../../src/files/index";

const initial = (): Tokens => ({
  accessToken: "access",
  refreshToken: "refresh",
  accessExpiresAt: 100_000,
  refreshExpiresAt: 1e12,
});

const response = (data: unknown, code = 0) =>
  new Response(JSON.stringify({ code, data, msg: "Denied" }));

function setup(transport: Transport, tokens = initial()) {
  let current = tokens;

  const save = vi.fn((t: Tokens) => {
    current = t;
  });

  return {
    client: new AccountClient({
      accountId: "a",
      endpoint: "https://a.test",
      transport,
      tokens: () => current,
      saveTokens: save,
      now: () => 1,
    }),
    save,
  };
}

describe("Account lifetime", () => {
  it("rejects authenticated storage-host requests before sending credentials", async () => {
    const transport = vi.fn();
    const { client } = setup(transport);

    await expect(client.request("https://storage.test/api/v4/file")).rejects.toThrow("Untrusted");
    expect(transport).not.toHaveBeenCalled();
  });

  it("deduplicates refresh and uses the refreshed token", async () => {
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/refresh")
        ? response({
            access_token: "new",
            refresh_token: "r2",
            access_expires: "2030-01-01",
            refresh_expires: "2031-01-01",
          })
        : response(new Headers(init?.headers).get("Authorization")),
    );

    const { client, save } = setup(transport as Transport, {
      ...initial(),
      accessExpiresAt: 0,
    });

    expect(
      await Promise.all([client.request("/api/v4/file"), client.request("/api/v4/file")]),
    ).toEqual(["Bearer new", "Bearer new"]);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("invalidates an in-flight refresh before it can persist credentials", async () => {
    let resolve!: (r: Response) => void;

    const transport = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );

    const { client, save } = setup(transport as Transport, {
      ...initial(),
      accessExpiresAt: 0,
    });

    const operation = client.request("/api/v4/file");

    await vi.waitFor(() => expect(transport).toHaveBeenCalled());

    const rejected = expect(operation).rejects.toThrow("Session ended");

    client.invalidate();

    resolve(
      response({
        access_token: "new",
        refresh_token: "r2",
        access_expires: "2030-01-01",
        refresh_expires: "2031-01-01",
      }),
    );

    await rejected;
    expect(save).not.toHaveBeenCalled();
  });

  it("does not return stale results after logout", async () => {
    let resolve!: (r: Response) => void;

    const transport = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );

    const { client } = setup(transport as Transport);
    const operation = client.request("/api/v4/file");

    await Promise.resolve();
    await vi.waitFor(() => expect(transport).toHaveBeenCalled());

    const rejected = expect(operation).rejects.toThrow("Session ended");

    client.invalidate();
    resolve(response({ secret: true }));
    await rejected;
  });

  it("retries an authorization failure once with renewed credentials", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(response(null, 40020))
      .mockResolvedValueOnce(
        response({
          access_token: "new",
          refresh_token: "r2",
          access_expires: "2030-01-01",
          refresh_expires: "2031-01-01",
        }),
      )
      .mockResolvedValueOnce(response(["file"]));

    const { client } = setup(transport);

    expect(await client.request("/api/v4/file")).toEqual(["file"]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("encodes Unicode names without permitting path traversal", () => {
    expect(decodeURIComponent(childUri("cloudreve://my/", "中文 #.txt"))).toBe(
      "cloudreve://my/中文 #.txt",
    );

    expect(() => childUri("cloudreve://my/", "../private")).toThrow("valid file name");
  });
});

it("does not persist malformed token fields", async () => {
  const transport = vi.fn(async () =>
    response({
      access_token: 123,
      refresh_token: "r",
      access_expires: "2030-01-01",
      refresh_expires: "2031-01-01",
    }),
  );

  const { client, save } = setup(transport as Transport, {
    ...initial(),
    accessExpiresAt: 0,
  });

  await expect(client.request("/api/v4/file")).rejects.toThrow("Invalid token");
  expect(save).not.toHaveBeenCalled();
});

it("awaits durable refresh persistence and rejects persistence failures before API replay", async () => {
  const token = {
    access_token: "next",
    refresh_token: "r2",
    access_expires: new Date(Date.now() + 600000).toISOString(),
    refresh_expires: new Date(Date.now() + 1200000).toISOString(),
  };

  let release!: () => void;

  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });

  const transport = vi.fn(async (url: string) =>
    Response.json({ code: 0, data: url.endsWith("refresh") ? token : "ok" }),
  );

  let saved: Tokens = {
    accessToken: "old",
    refreshToken: "r",
    accessExpiresAt: 0,
    refreshExpiresAt: Date.now() + 600000,
  };

  const persist = vi.fn(async (next: Tokens, signal: AbortSignal) => {
    await wait;
    signal.throwIfAborted();
    saved = next;
  });

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://s",
    transport,
    tokens: () => saved,
    saveTokens: persist,
  });

  const result = client.request("/api/v4/file");

  await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  expect(transport).toHaveBeenCalledTimes(1);
  release();
  expect(await result).toBe("ok");
  expect(saved.accessToken).toBe("next");

  const failed = new AccountClient({
    accountId: "a",
    endpoint: "https://s",
    transport,
    tokens: () => ({ ...saved, accessExpiresAt: 0 }),
    saveTokens: async () => {
      throw Error("disk full");
    },
  });

  await expect(failed.request("/api/v4/file")).rejects.toThrow("disk full");
});

it("invalidates an asynchronous credential write when logout wins the race", async () => {
  let release!: () => void;

  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tokens: Tokens = {
    accessToken: "old",
    refreshToken: "r",
    accessExpiresAt: 0,
    refreshExpiresAt: Date.now() + 600000,
  };

  const commit = vi.fn();

  const persist = vi.fn(async (next: Tokens, signal: AbortSignal) => {
    await wait;
    signal.throwIfAborted();
    commit(next);
  });

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://s",
    tokens: () => tokens,
    saveTokens: persist,
    transport: async () =>
      Response.json({
        code: 0,
        data: {
          access_token: "new",
          refresh_token: "r2",
          access_expires: new Date(Date.now() + 600000).toISOString(),
          refresh_expires: new Date(Date.now() + 1200000).toISOString(),
        },
      }),
  });

  const result = client.request("/api/v4/file");
  const rejected = expect(result).rejects.toThrow();

  await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  client.invalidate();
  release();
  await rejected;
  expect(commit).not.toHaveBeenCalled();
});
