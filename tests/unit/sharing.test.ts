import { expect, it, vi } from "vitest";
import { Shares, shareLink, shareSourceUri } from "@cloudreve/sdk/shares";
import { WebDAV, davOptions } from "@cloudreve/sdk/webdav";
import { AccountClient } from "@cloudreve/sdk/session";

function fixture(data: unknown) {
  const transport = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ code: 0, data }),
  );

  return {
    transport,
    client: new AccountClient({
      accountId: "a",
      endpoint: "https://server.test",
      transport,
      tokens: () => ({
        accessToken: "a",
        refreshToken: "r",
        accessExpiresAt: Date.now() + 100000,
        refreshExpiresAt: Date.now() + 200000,
      }),
      saveTokens: () => {},
    }),
  };
}

it("keeps empty share/DAV collections usable and sends owner-only detail requests", async () => {
  const f = fixture({
    shares: null,
    accounts: null,
    pagination: { page: 0, page_size: 50 },
  });

  expect((await new Shares(f.client).list()).shares).toEqual([]);
  expect((await new WebDAV(f.client).list()).accounts).toEqual([]);

  f.transport.mockImplementation(async () =>
    Response.json({
      code: 0,
      data: { id: "s", visited: 0, url: "https://server.test/s/s" },
    }),
  );

  await new Shares(f.client).info("a/b");
  expect(f.transport.mock.lastCall?.[0]).toContain("a%2Fb?owner_extended=true");
});

it("validates share options before mutation and preserves update semantics", async () => {
  const f = fixture("https://server.test/s/link");
  const shares = new Shares(f.client);

  await expect(shares.save({ uri: "cloudreve://trash/file" })).rejects.toThrow("Choose");
  await expect(shares.save({ uri: "cloudreve://my/file", password: "bad!" })).rejects.toThrow("32");
  await expect(shares.save({ uri: "cloudreve://my/file", downloads: -1 })).rejects.toThrow("whole");
  expect(f.transport).not.toHaveBeenCalled();

  f.transport.mockImplementation(async (_url, init) =>
    Response.json({
      code: 0,
      data:
        init?.method === "POST"
          ? "https://server.test/s/link"
          : {
              id: "id",
              visited: 0,
              url: "https://server.test/s/link",
              is_private: true,
              password: "Private42",
            },
    }),
  );

  await shares.save(
    {
      uri: "cloudreve://my/file",
      expire: 600,
      downloads: 2,
      is_private: true,
      password: "Private42",
    },
    "id",
  );

  expect(f.transport.mock.lastCall?.[1]).toMatchObject({ method: "POST" });
  expect(() => shareLink("javascript:alert(1)")).toThrow();
});

it("enforces DAV root syntax and decodes persisted options", async () => {
  const f = fixture({
    id: "dav",
    name: "Device",
    uri: "cloudreve://my/",
    password: "secret",
    options: "Bw==",
  });

  const dav = new WebDAV(f.client);

  await expect(dav.save({ name: "", uri: "cloudreve://my/" })).rejects.toThrow("name");
  await expect(dav.save({ name: "Device", uri: "cloudreve://trash/" })).rejects.toThrow("root");

  const value = await dav.save({ name: "Device", uri: "cloudreve://my/", readonly: true }, "dav");

  expect(davOptions(value)).toMatchObject({
    readonly: true,
    proxy: true,
    disable_sys_files: true,
  });

  expect(f.transport.mock.lastCall?.[1]).toMatchObject({ method: "PATCH" });
  await dav.revoke("dav");
  expect(f.transport.mock.lastCall?.[1]).toMatchObject({ method: "DELETE" });
});

it("resolves the shared file inside its parent rather than changing the share target", () => {
  const value = {
    source_uri: "cloudreve://user@my/folder",
    source_type: 0,
    name: "中文.txt",
  };

  expect(shareSourceUri(value as never)).toBe("cloudreve://user@my/folder/%E4%B8%AD%E6%96%87.txt");
  expect(shareSourceUri({ ...value, source_type: 1 } as never)).toBe(value.source_uri);
  expect(() => shareSourceUri({} as never)).toThrow("unavailable");
});

it("uses the owner's password to resolve a private share and rejects unsafe direct links", async () => {
  const f = fixture({
    id: "s",
    visited: 0,
    url: "https://server.test/s/s",
    password: "Secret42",
  });

  const shares = new Shares(f.client);

  await shares.info("s");
  expect(f.transport.mock.lastCall?.[0]).toContain("password=Secret42");

  f.transport.mockImplementation(async () =>
    Response.json({
      code: 0,
      data: [{ file_url: "cloudreve://my/file", link: "javascript:bad" }],
    }),
  );

  await expect(shares.direct("cloudreve://my/file")).rejects.toThrow("share link");
});

it("finds DAV accounts beyond the first page and stops broken repeated cursors", async () => {
  const f = fixture({ accounts: [], pagination: { next_token: "next" } });
  const dav = new WebDAV(f.client);

  f.transport.mockResolvedValueOnce(
    Response.json({
      code: 0,
      data: { accounts: [], pagination: { next_token: "next" } },
    }),
  );

  f.transport.mockResolvedValueOnce(
    Response.json({
      code: 0,
      data: {
        accounts: [{ id: "id", name: "DAV", uri: "cloudreve://my/", password: "secret" }],
        pagination: {},
      },
    }),
  );

  expect((await dav.get("id")).name).toBe("DAV");
  await expect(dav.get("missing")).rejects.toThrow("pagination");
});

it("rejects malformed expiry data before it reaches native date controls", async () => {
  const f = fixture({
    shares: [
      {
        id: "s",
        visited: 0,
        url: "https://server.test/s/s",
        expires: "not-a-date",
      },
    ],
    pagination: { page: 0, page_size: 50 },
  });

  await expect(new Shares(f.client).list()).rejects.toThrow("Invalid share expiry");
});

it("preserves valid share deadlines and normalizes an absent deadline", async () => {
  const row = { id: "s", visited: 0, url: "https://server.test/s/s" };
  const expiry = "2026-09-10T12:00:00Z";

  const f = fixture({
    shares: [
      { ...row, expires: expiry },
      { ...row, id: "t", expires: null },
    ],
    pagination: { page: 0, page_size: 50 },
  });

  expect((await new Shares(f.client).list()).shares.map((share) => share.expires)).toEqual([
    expiry,
    undefined,
  ]);
});

it("validates public direct-link route identity and encoded filenames", async () => {
  const { validateDirectLink } = await import("../../src/shares/index");
  const endpoint = "https://server.test";
  const name = encodeURIComponent("音乐 #%.txt");

  expect(validateDirectLink(endpoint + "/f/id0/file10.txt", endpoint)).toBe(
    endpoint + "/f/id0/file10.txt",
  );

  expect(validateDirectLink(`${endpoint}/f/id/${name}`, endpoint)).toBe(`${endpoint}/f/id/${name}`);

  expect(validateDirectLink(`${endpoint}/f/d/id/${name}`, endpoint)).toBe(
    `${endpoint}/f/d/id/${name}`,
  );

  expect(validateDirectLink(`http://server.test/f/id/a.txt`, "http://server.test")).toBe(
    "http://server.test/f/id/a.txt",
  );

  for (const url of [
    "https://other.test/f/id/name",
    "https://u:p@server.test/f/id/name",
    `${endpoint}/s/id`,
    `${endpoint}/f/id/name/extra`,
    `${endpoint}/f//name`,
    `${endpoint}/f/id/`,
    `${endpoint}/f/id/name#fragment`,
    `${endpoint}/f/id/%ZZ`,
    `${endpoint}/f/id/a%2Fb`,
    "file:///f/id/name",
  ]) {
    expect(() => validateDirectLink(url, endpoint)).toThrow("Invalid direct link");
  }
});

it("rejects unsupported protection changes before any update request", async () => {
  for (const update of [{ is_private: false }, { password: "New42" }, { password: "" }]) {
    const f = fixture({
      id: "s",
      visited: 0,
      url: "https://server.test/s/s",
      is_private: true,
      password: "Private42",
    });

    await expect(
      new Shares(f.client).save({ uri: "cloudreve://my/a", ...update }, "s"),
    ).rejects.toThrow("cannot change existing share");

    expect(f.transport.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(
      true,
    );
  }

  const publicLink = fixture({
    id: "s",
    visited: 0,
    url: "https://server.test/s/s",
  });

  await expect(
    new Shares(publicLink.client).save({ uri: "cloudreve://my/a", is_private: true }, "s"),
  ).rejects.toThrow("cannot change");
});

it("keeps creation, omitted protection updates and unchanged public/private values usable", async () => {
  for (const current of [
    { is_private: true, password: "Private42" },
    { password_protected: true, password: "Private42" },
    { password: "Private42" },
    {},
  ]) {
    const f = fixture(null);

    f.transport.mockImplementation(async (_url, init) =>
      Response.json({
        code: 0,
        data:
          (init?.method ?? "GET") === "GET"
            ? {
                id: "s",
                visited: 0,
                url: "https://server.test/s/s",
                ...current,
              }
            : "https://server.test/s/s",
      }),
    );

    const shares = new Shares(f.client);

    expect(
      await shares.save(
        {
          uri: "cloudreve://my/a",
          is_private: !!current.password,
          password: current.password ?? "",
        },
        "s",
      ),
    ).toBe("https://server.test/s/s");

    f.transport.mockClear();
    await shares.save({ uri: "cloudreve://my/a", expire: 300 }, "s");
    expect(f.transport.mock.calls).toHaveLength(1);
    expect(f.transport.mock.lastCall?.[1]?.method).toBe("POST");
    f.transport.mockClear();

    await shares.save({
      uri: "cloudreve://my/a",
      is_private: true,
      password: "Create42",
    });

    expect(f.transport.mock.calls).toHaveLength(1);
    expect(f.transport.mock.lastCall?.[1]?.method).toBe("PUT");
  }
});

it("keeps preflight and mutation under one cancellation/deadline scope", async () => {
  const f = fixture(null);
  const controller = new AbortController();

  f.transport.mockImplementation(async () => {
    controller.abort(new Error("cancelled"));

    return Response.json({
      code: 0,
      data: { id: "s", visited: 0, url: "https://server.test/s/s" },
    });
  });

  await expect(
    new Shares(f.client).save({ uri: "cloudreve://my/a", is_private: false }, "s", {
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");

  expect(f.transport.mock.calls).toHaveLength(1);
  vi.useFakeTimers();

  try {
    const deadline = fixture(null);

    deadline.transport.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );

    const outcome = expect(
      new Shares(deadline.client).save({ uri: "cloudreve://my/a", is_private: false }, "s", {
        timeoutMs: 5,
      }),
    ).rejects.toThrow();

    await vi.runAllTimersAsync();
    await outcome;
    expect(deadline.transport.mock.calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
