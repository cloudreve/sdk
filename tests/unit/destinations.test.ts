import { it, expect, vi } from "vitest";
import { Files } from "@cloudreve/sdk/files";
import { AccountClient } from "@cloudreve/sdk/session";

const file = (path: string, type = 0) => ({
  id: path,
  name: new URL(path).pathname.split("/").at(-1)!,
  path,
  type,
  size: 0,
  created_at: "",
  updated_at: "",
});

function setup(extra: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = {
    "cloudreve://my/": file("cloudreve://my/", 1),
    "cloudreve://my/a": file("cloudreve://my/a"),
    "cloudreve://my/d": file("cloudreve://my/d", 1),
    ...extra,
  };

  const transport = vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
    const uri = u.searchParams.get("uri")?.replace(/\/$/, "") || "cloudreve://my/";

    if (u.pathname === "/api/v4/file") {
      return Response.json({
        code: 0,
        data: {
          files: [],
          parent: entries["cloudreve://my/"],
          pagination: { page: 0, page_size: 1 },
          props: {},
        },
      });
    }

    if (u.pathname.endsWith("/info")) {
      if (uri === "cloudreve://my") {
        return Response.json({ code: 403, msg: "Cannot operate root file" });
      }

      const value = entries[uri] ?? entries[uri + "/"];

      return Response.json(
        value ? { code: 0, data: value } : { code: 40016, msg: "Path not exist" },
      );
    }

    return Response.json({ code: 0, data: {} });
  });

  const files = new Files(
    new AccountClient({
      accountId: "u",
      endpoint: "https://s",
      transport,
      tokens: () => ({
        accessToken: "a",
        refreshToken: "r",
        accessExpiresAt: Date.now() + 600000,
        refreshExpiresAt: Date.now() + 1200000,
      }),
      saveTokens: () => {},
    }),
  );

  return {
    files,
    transport,
    mutations: () => transport.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}

it("resolves known absence without swallowing permission, conflict or transport errors", async () => {
  for (const code of [404, 40016, 40004, 403]) {
    const files = new Files({
      request: async () => {
        const { ApiError } = await import("@cloudreve/sdk/protocol");

        throw new ApiError(code, "error");
      },
    } as any);

    if ([404, 40016].includes(code)) {
      expect(await files.infoIfExists("cloudreve://my/a")).toBeUndefined();
    } else {
      await expect(files.infoIfExists("cloudreve://my/a")).rejects.toMatchObject({ code });
    }
  }
});

it("maps directory, absent exact target and same-directory rename to single server mutations", async () => {
  const s = setup();

  expect(
    await s.files.copyTo("cloudreve://my/a", "cloudreve://my/d/", {
      copy: true,
      requireDirectory: true,
    }),
  ).toEqual({ uri: "cloudreve://my/d/a", operation: "copy" });

  expect(JSON.parse(s.mutations()[0]![1]!.body as string)).toEqual({
    uris: ["cloudreve://my/a"],
    dst: "cloudreve://my/d",
    copy: true,
  });

  expect(await s.files.copyTo("cloudreve://my/a", "cloudreve://my/b")).toEqual({
    uri: "cloudreve://my/b",
    operation: "rename",
  });

  expect(JSON.parse(s.mutations()[1]![1]!.body as string)).toEqual({
    uri: "cloudreve://my/a",
    new_name: "b",
  });

  expect(await s.files.copyTo("cloudreve://my/a", "cloudreve://my/d/a")).toEqual({
    uri: "cloudreve://my/d/a",
    operation: "move",
  });

  expect(await s.files.resolveDestination("upload.bin", "cloudreve://my/d")).toEqual({
    uri: "cloudreve://my/d/upload.bin",
    parent: "cloudreve://my/d",
  });
});

it("fails unsafe targets before issuing any mutations", async () => {
  for (const destination of [
    "cloudreve://trash/a",
    "cloudreve://other@my/a",
    "cloudreve://id:secret@share/a",
    "cloudreve://my/d?name=a",
    "cloudreve://my/a",
  ]) {
    const s = setup();

    await expect(s.files.copyTo("cloudreve://my/a", destination)).rejects.toThrow();
    expect(s.mutations()).toHaveLength(0);
  }

  for (const source of [
    "cloudreve://trash/a",
    "cloudreve://other@my/a",
    "cloudreve://my/",
    "cloudreve://my/a?name=x",
    "cloudreve://id:secret@share/a",
  ]) {
    const s = setup();

    await expect(s.files.copyTo(source, "cloudreve://my/d")).rejects.toThrow();
    expect(s.mutations()).toHaveLength(0);
  }

  for (const [dst, opts] of [
    ["cloudreve://my/missing", { requireDirectory: true }],
    ["cloudreve://my/different", { copy: true }],
    ["cloudreve://my/d/different", {}],
    ["cloudreve://my/a/child", {}],
    ["cloudreve://my/%20b%20", {}],
  ] as const) {
    const s = setup();

    await expect(s.files.copyTo("cloudreve://my/a", dst, opts)).rejects.toThrow();
    expect(s.mutations()).toHaveLength(0);
  }

  const collision = setup({ "cloudreve://my/d/a": file("cloudreve://my/d/a") });

  await expect(
    collision.files.copyTo("cloudreve://my/a", "cloudreve://my/d"),
  ).rejects.toMatchObject({ code: 40004 });

  expect(collision.mutations()).toHaveLength(0);
});

it("requires recursive copy intent and rejects moving a directory beneath itself", async () => {
  const s = setup();

  await expect(
    s.files.copyTo("cloudreve://my/d", "cloudreve://my/", { copy: true }),
  ).rejects.toThrow("recursive");

  await expect(
    s.files.copyTo("cloudreve://my/d", "cloudreve://my/d/child", {
      copy: true,
      recursive: true,
    }),
  ).rejects.toThrow("itself");

  expect(s.mutations()).toHaveLength(0);

  const valid = setup({
    "cloudreve://my/other": file("cloudreve://my/other", 1),
  });

  expect(
    await valid.files.copyTo("cloudreve://my/d", "cloudreve://my/other", {
      copy: true,
      recursive: true,
    }),
  ).toEqual({ uri: "cloudreve://my/other/d", operation: "copy" });
});

it("reads personal root descriptors through listing and forwards cancellation", async () => {
  const s = setup();
  const controller = new AbortController();

  expect(await s.files.info("cloudreve://my/", { signal: controller.signal })).toMatchObject({
    type: 1,
    path: "cloudreve://my/",
  });

  expect(s.transport.mock.calls[0]![0]).toContain("/api/v4/file?");
  expect(s.transport.mock.calls.some(([url]) => url.includes("/info"))).toBe(false);
  controller.abort();
  await expect(s.files.info("cloudreve://my/", { signal: controller.signal })).rejects.toThrow();
  await expect(setup({ "cloudreve://my/": null }).files.info("cloudreve://my/")).rejects.toThrow();
});
