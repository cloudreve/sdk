import { it, expect, vi } from "vitest";
import { Files } from "../../src/files/index";
import { AccountClient } from "../../src/session/index";

const data = {
  files: [],
  pagination: { page: 0, page_size: 50 },
  props: {
    max_page_size: 100,
    order_by_options: ["name", "size"],
    order_direction_options: ["asc", "desc"],
  },
};

it("sends search, sorting, cursor and numbered paging through the captured account", async () => {
  const transport = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data })),
  );

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://a.test",
    tokens: () => ({
      accessToken: "token",
      refreshToken: "refresh",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
    transport,
  });

  const files = new Files(client);

  expect(
    await files.list("cloudreve://my/中文", {
      page: 2,
      page_size: 25,
      order_by: "name",
      order_direction: "desc",
      next_page_token: "cursor",
    }),
  ).toEqual(data);

  const url = new URL(transport.mock.calls[0]![0]);

  expect(url.origin).toBe("https://a.test");

  expect(Object.fromEntries(url.searchParams)).toEqual({
    uri: "cloudreve://my/中文",
    page: "2",
    page_size: "25",
    order_by: "name",
    order_direction: "desc",
    next_page_token: "cursor",
  });
});

it("normalizes null search sorting capabilities while rejecting malformed values", async () => {
  const { decodeDirectory } = await import("../../src/files/schemas");

  for (const absent of [null, undefined]) {
    expect(
      decodeDirectory({
        ...data,
        props: {
          ...data.props,
          order_by_options: absent,
          order_direction_options: absent,
        },
      }).props,
    ).toEqual({
      ...data.props,
      order_by_options: [],
      order_direction_options: [],
    });
  }

  for (const malformed of ["name", [1]]) {
    expect(() =>
      decodeDirectory({
        ...data,
        props: { ...data.props, order_by_options: malformed },
      }),
    ).toThrow("Invalid directory");

    expect(() =>
      decodeDirectory({
        ...data,
        props: { ...data.props, order_direction_options: malformed },
      }),
    ).toThrow("Invalid directory");
  }
});

it("isolates default sorting arrays between directory responses", async () => {
  const { decodeDirectory } = await import("../../src/files/schemas");

  const input = {
    ...data,
    props: {
      ...data.props,
      order_by_options: null,
      order_direction_options: null,
    },
  };

  const first = decodeDirectory(input);
  const second = decodeDirectory(input);

  first.props.order_by_options.push("name");
  first.props.order_direction_options.push("asc");
  expect(second.props.order_by_options).toEqual([]);
  expect(second.props.order_direction_options).toEqual([]);
});

it("accepts observed one-item preflight views without weakening view PATCH constraints", async () => {
  const { decodeDirectory } = await import("../../src/files/schemas");
  const { ExplorerViewSchema } = await import("../../src/files/view");
  const { decode } = await import("../../src/protocol/index");

  // Source fixture GETfile?page_size=1, with view sync enabled, returns exactly this view.
  const view = { page_size: 1, view: "grid", thumbnail: true };

  expect(decodeDirectory({ ...data, view }).view).toEqual(view);

  expect(decodeDirectory({ ...data, view: { page_size: 0, gallery_width: 0 } }).view).toEqual({
    page_size: 0,
    gallery_width: 0,
  });

  expect(() => decode(ExplorerViewSchema, view)).toThrow();
});

it("rejects category/filter intersections at URI builder and raw listing entry", async () => {
  const { CrUri } = await import("../../src/files/index");

  expect(() => CrUri.my.withSearchParams({ category: "document", name: ["needle"] })).toThrow(
    "Category",
  );

  expect(CrUri.myDocuments.withSearchParams({ name: ["needle"] }).category()).toBeNull();

  const transport = vi.fn(async () => Response.json({ code: 0, data }));

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://a.test",
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
    transport,
  });

  const files = new Files(client);

  for (const uri of [
    "cloudreve://my/?category=document&name=x",
    "cloudreve://my/?category=document&meta_tag%3Ax=",
  ]) {
    await expect(files.list(uri)).rejects.toThrow("Category");
    expect(() => files.listStream(uri)).toThrow("Category");
  }

  expect(transport).not.toHaveBeenCalled();

  await files.list(CrUri.myDocuments.toString(), {
    page_size: 1,
    order_by: "name",
  });

  expect(transport).toHaveBeenCalledTimes(1);
});
