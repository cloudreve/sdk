import { it, expect, vi } from "vitest";
import { createPublicClient } from "../../src/client";
import { Files } from "../../src/files/index";

const share = "cloudreve://id:secret@share/";
const file = { id: "f", name: "x", path: share + "x", type: 0, size: 0 };

it("exposes readonly anonymous resources and strips ambient credentials on all requests", async () => {
  let data: unknown = {
    files: [file],
    pagination: { page: 0, page_size: 1 },
    props: {},
  };

  const transport = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");

    return Response.json({ code: 0, data });
  });

  const client = createPublicClient({
    endpoint: "https://server.test/base",
    transport,
  });

  expect(Object.keys(client.account)).toEqual(["userInfo"]);
  expect("create" in client.files).toBe(false);
  expect("session" in client).toBe(false);

  expect(
    (
      await client.files.list(
        share,
        {},
        {
          headers: {
            Authorization: "Bearer should-not-send",
            Cookie: "session=secret",
          },
        },
      )
    ).files,
  ).toHaveLength(1);

  const frames = [];

  for await (const frame of client.files.listStream(share)) {
    frames.push(frame);
  }

  expect(frames).toHaveLength(1);
  data = file;
  expect((await client.files.info(share + "x")).id).toBe("f");
  data = { urls: [{ url: "https://storage.test/file" }] };
  expect(await client.files.urls([share + "x"], true)).toEqual(["https://storage.test/file"]);
  expect(await client.files.viewerUrl(share + "x")).toBe("https://storage.test/file");

  transport.mockImplementationOnce(async (_url, init) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);

    return Response.json({
      code: 0,
      data: {
        id: "id",
        visited: 0,
        url: "https://server.test/s/id",
        unlocked: true,
        expired: false,
      },
    });
  });

  transport.mockImplementationOnce(async () =>
    Response.json({
      code: 0,
      data: { files: [file], pagination: { page: 0, page_size: 1 }, props: {} },
    }),
  );

  expect(
    await client.files.archiveUrl([share], {
      headers: { Authorization: "must-not-send", Cookie: "must-not-send" },
    }),
  ).toBe("https://storage.test/file");

  expect(JSON.parse(String(transport.mock.lastCall?.[1]?.body))).toEqual({
    uris: ["cloudreve://id:secret@share/x"],
    download: true,
    archive: true,
  });

  const before = transport.mock.calls.length;

  await expect(client.files.archiveUrl([])).rejects.toThrow();
  await expect(client.files.archiveUrl([share, "cloudreve://my/private"])).rejects.toThrow();
  expect(transport.mock.calls).toHaveLength(before);
  data = { url: "https://storage.test/thumb" };
  expect((await client.files.thumbnail(share + "x")).url).toContain("thumb");

  data = {
    id: "id",
    visited: 0,
    url: "https://server.test/s/id",
    unlocked: false,
  };

  expect((await client.shares.resolve("id")).unlocked).toBe(false);
  data = { shares: [], pagination: { page: 0, page_size: 50 } };
  expect((await client.shares.publicList("u")).shares).toEqual([]);
  data = { id: "u", nickname: "User" };
  expect((await client.account.userInfo("u")).nickname).toBe("User");
  client.dispose();
});

it("rejects nonshare namespaces and every mixed URL array before transport", async () => {
  const transport = vi.fn();

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
  });

  for (const bad of [
    "cloudreve://my/private",
    "cloudreve://share/",
    "https://foreign.test/file",
    "bad",
  ]) {
    await expect(client.files.list(bad)).rejects.toThrow("share URI");
    await expect(client.files.info(bad)).rejects.toThrow();
    await expect(client.files.viewerUrl(bad)).rejects.toThrow();
    await expect(client.files.thumbnail(bad)).rejects.toThrow();
    expect(() => client.files.listStream(bad)).toThrow();
    await expect(client.files.urls([share, bad])).rejects.toThrow();
  }

  await expect(client.files.urls([])).rejects.toThrow();
  await expect(client.files.urls("bad" as never)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  client.dispose();

  for (const endpoint of ["file:///tmp", "https://u:p@server.test"]) {
    expect(() => createPublicClient({ endpoint, transport })).toThrow();
  }

  const scope = {
    endpoint: "https://server.test",
    signal: new AbortController().signal,
    request: vi.fn(),
    consume: vi.fn(),
  };

  expect(() => new Files(scope).accountId).toThrow("no account");
});

it("cancels anonymous requests and never refreshes or follows redirects", async () => {
  const controller = new AbortController();
  const transport = vi.fn(async () => Response.json({ code: 40020, msg: "not authorized" }));

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
    signal: controller.signal,
  });

  await expect(client.files.info(share)).rejects.toThrow("not authorized");
  expect(transport).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(client.files.info(share)).rejects.toThrow("cancel");
  client.dispose();

  const aborted = createPublicClient({
    endpoint: "https://server.test",
    transport,
    signal: AbortSignal.abort(),
  });

  await expect(aborted.account.userInfo("u")).rejects.toThrow("cancel");
  aborted.dispose();

  const redirect = vi.fn(
    async () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://foreign.test" },
      }),
  );

  await expect(
    createPublicClient({
      endpoint: "https://server.test",
      transport: redirect,
    }).files.info(share),
  ).rejects.toMatchObject({ httpStatus: 302 });

  expect(redirect).toHaveBeenCalledTimes(1);
});

it("releases public streaming bodies on disposal and total deadline", async () => {
  const cancel = vi.fn();

  const transport = async () =>
    new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "text/event-stream" },
    });

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
  });

  const stream = client.files.listStream(share);
  const pending = stream.next();

  await new Promise((r) => setTimeout(r, 2));
  client.dispose();
  await expect(pending).rejects.toThrow("cancel");
  expect(cancel).toHaveBeenCalled();

  const timed = createPublicClient({
    endpoint: "https://server.test",
    transport,
    timeoutMs: 2,
  });

  await expect(timed.files.list(share)).rejects.toThrow("timed out");
  timed.dispose();
});

it("does not issue an archive request when source credentials are rejected", async () => {
  const transport = vi.fn(async () =>
    Response.json({ code: 40069, msg: "Incorrect share password" }),
  );

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
  });

  await expect(client.files.archiveUrl([share])).rejects.toMatchObject({
    code: 40069,
  });

  expect(transport).toHaveBeenCalledOnce();
  client.dispose();
});

it("validates locked share roots and non-root archive sources", async () => {
  const transport = vi.fn(async (url: string) =>
    Response.json({
      code: 0,
      data: url.includes("/share/info/")
        ? {
            id: "id",
            visited: 0,
            url: "https://server.test/s/id",
            unlocked: false,
          }
        : url.includes("/file/info")
          ? file
          : { urls: [{ url: "https://storage.test/archive.zip" }] },
    }),
  );

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
  });

  await expect(client.files.archiveUrl([share])).rejects.toThrow("locked");
  expect(await client.files.archiveUrl([share + "x"])).toBe("https://storage.test/archive.zip");
  client.dispose();
});

it("refuses shared-root names that would change and empty selections", async () => {
  for (const names of [[" x"], []]) {
    const transport = vi.fn(async (url: string) =>
      Response.json({
        code: 0,
        data: url.includes("/share/info/")
          ? {
              id: "id",
              visited: 0,
              url: "https://server.test/s/id",
              unlocked: true,
            }
          : {
              files: names.map((name) => ({ ...file, name })),
              pagination: { page: 0, page_size: 50 },
              props: {},
            },
      }),
    );

    const client = createPublicClient({
      endpoint: "https://server.test",
      transport,
    });

    await expect(client.files.archiveUrl([share])).rejects.toThrow();
    expect(transport.mock.calls.some(([url]) => url.includes("/file/url"))).toBe(false);
    client.dispose();
  }
});

it("rejects directory archive sources before the backend can return a partial ZIP", async () => {
  for (const uri of [share, share + "folder"]) {
    const transport = vi.fn(async (url: string) =>
      Response.json({
        code: 0,
        data: url.includes("/share/info/")
          ? {
              id: "id",
              visited: 0,
              url: "https://server.test/s/id",
              unlocked: true,
            }
          : url.includes("/file/info")
            ? { ...file, type: 1 }
            : {
                files: [file, { ...file, type: 1, name: "folder" }],
                pagination: { page: 0, page_size: 50 },
                props: {},
              },
      }),
    );

    const client = createPublicClient({
      endpoint: "https://server.test",
      transport,
    });

    await expect(client.files.archiveUrl([uri])).rejects.toThrow("omit folder descendants");
    expect(transport.mock.calls.some(([url]) => url.includes("/file/url"))).toBe(false);
    client.dispose();
  }
});
