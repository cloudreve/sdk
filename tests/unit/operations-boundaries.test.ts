import { it, expect, vi } from "vitest";
import {
  Files,
  CrUri,
  fileActions,
  nextPage,
  validateName,
  childUri,
  fileEntry,
} from "@cloudreve/sdk/files";
import { AccountClient, Authentication } from "@cloudreve/sdk/session";
import { Profile, avatarUrl } from "@cloudreve/sdk/profile";
import { Shares, shareSourceUri } from "@cloudreve/sdk/shares";
import { WebDAV } from "@cloudreve/sdk/webdav";
import { Jobs, ListTaskCategory, TaskType, TaskStatus } from "@cloudreve/sdk/jobs";

function setup(initial: unknown) {
  let data = initial;
  const transport = vi.fn(async () => Response.json({ code: 0, data }));

  const client = new AccountClient({
    accountId: "u",
    endpoint: "https://server.test",
    transport,
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    }),
    saveTokens: () => {},
  });

  return {
    client,
    transport,
    set: (value: unknown) => {
      data = value;
    },
    body: () => JSON.parse(transport.mock.lastCall?.[1]?.body as string),
    url: () => transport.mock.lastCall?.[0],
  };
}

const entry = {
  id: "f",
  name: "file",
  path: "cloudreve://my/file",
  type: 0,
  size: 0,
  created_at: "",
  updated_at: "",
};

it("preserves URI identity, segments, categories and the full search vocabulary", () => {
  const root = new CrUri("cloudreve://share-id:password@share/");

  expect(root.fs()).toBe("share");
  expect(root.id()).toBe("share-id");
  expect(root.password()).toBe("password");
  expect(root.isRoot()).toBe(true);
  expect(root.elements()).toEqual([]);

  const file = root.join("你好 ?#%", "a.txt");

  expect(file.path()).toBe("/你好 ?#%/a.txt");
  expect(file.elements()).toEqual(["你好 ?#%", "a.txt"]);
  expect(file.isRoot()).toBe(false);
  expect(file.parent().elements()).toEqual(["你好 ?#%"]);
  expect(file.parent().parent().isRoot()).toBe(true);
  expect(root.parent().isRoot()).toBe(true);
  expect(new CrUri("cloudreve://my/folder/").toString()).toBe("cloudreve://my/folder");
  expect(CrUri.my.category()).toBe(null);
  expect(CrUri.my.withCategory("image").category()).toBe("image");
  expect(CrUri.myImages.withCategory(null).category()).toBe(null);

  const params = {
    name: ["hello", "world"],
    caseFolding: true,
    type: "folder" as const,
    sizeGte: 0,
    sizeLte: 100,
    createdGte: 1,
    createdLte: 2,
    updatedGte: 3,
    updatedLte: 4,
  };

  expect(root.withSearchParams({ category: "image" }).category()).toBe("image");
  expect(new CrUri("cloudreve://my/?category=image&name=x").searchParams()?.category).toBe("image");

  const search = root.withSearchParams(params);

  expect(search.isSearch()).toBe(true);
  expect(search.searchParams()).toEqual(params);
  expect(root.searchParams()).toBeUndefined();
  expect(search.withSearchParams({}).isSearch()).toBe(false);

  for (const [query, result] of [
    ["type=0", "file"],
    ["type=1", "folder"],
    ["type=file", "file"],
    ["type=folder", "folder"],
    ["type=other", undefined],
  ] as const) {
    expect(new CrUri("cloudreve://my/?" + query).searchParams()?.type).toBe(result);
  }

  expect(new CrUri("cloudreve://my/?name=&size_gte=2").searchParams()).toEqual({
    sizeGte: 2,
  });

  expect(() => new CrUri("https://server.test")).toThrow("Invalid cloudreve URI");
});

it("validates file identity and preserves operation wire forms", async () => {
  for (const name of ["", " ", ".", "..", "a/b", "a\\b", "a\0b"]) {
    expect(() => validateName(name)).toThrow();
  }

  expect(childUri("cloudreve://my/dir?name=x", " space %.txt ")).toBe(
    "cloudreve://my/dir/space%20%25.txt",
  );

  for (const value of [
    { ...entry, id: 1 },
    { ...entry, name: null },
    { ...entry, path: 3 },
    { ...entry, type: 4 },
    { ...entry, path: "http://s" },
    { ...entry, path: "cloudreve:///file" },
    { ...entry, path: "cloudreve://my/%xx" },
  ]) {
    expect(() => fileEntry(value)).toThrow();
  }

  const s = setup(entry);
  const files = new Files(s.client);

  expect(files.accountId).toBe("u");
  await files.create("cloudreve://my/", "child", "folder");

  expect(s.body()).toEqual({
    uri: "cloudreve://my/child",
    type: "folder",
    err_on_conflict: true,
  });

  await files.rename(entry.path, " new ");
  expect(s.body()).toEqual({ uri: entry.path, new_name: "new" });
  await files.move([entry.path], "cloudreve://my/d");
  expect(s.body().copy).toBe(false);
  await files.move([entry.path], "cloudreve://my/d", true);
  expect(s.body().copy).toBe(true);
  await files.metadata([entry.path], [{ key: "a", value: "b" }]);
  expect(s.body().patches).toEqual([{ key: "a", value: "b" }]);
  await files.unlock(["lock"]);
  expect(s.body()).toEqual({ tokens: ["lock"] });
  await files.emptyTrash();
  expect(s.url()).toBe("https://server.test/api/v4/file/trash");
  await files.restore([entry.path]);
  expect(s.body()).toEqual({ uris: [entry.path] });
  await files.delete([entry.path]);
  expect(s.body().skip_soft_delete).toBe(false);
  await files.delete(["cloudreve://trash/file"], true);
  expect(s.body().skip_soft_delete).toBe(true);
  await expect(files.delete(["cloudreve://trash/file"])).rejects.toThrow("explicit permanent");
  s.set({ urls: [{ url: "/relative" }] });

  expect(await files.urls([entry.path], true, "entity", true)).toEqual([
    "https://server.test/relative",
  ]);

  expect(s.body()).toMatchObject({
    download: true,
    entity: "entity",
    no_cache: true,
  });

  for (const data of [{ urls: null }, { urls: [{}] }, { urls: [{ url: "file:///secret" }] }]) {
    s.set(data);
    await expect(files.urls([entry.path])).rejects.toThrow();
  }

  s.set({ url: "/thumbnail" });

  expect(await files.thumbnail(entry.path, "hint")).toEqual({
    url: "/thumbnail",
  });

  expect(new Headers(s.transport.mock.lastCall?.[1]?.headers).get("X-Cr-Context-Hint")).toBe(
    "hint",
  );

  await files.thumbnail(entry.path);
  expect(new Headers(s.transport.mock.lastCall?.[1]?.headers).has("X-Cr-Context-Hint")).toBe(false);

  for (const url of ["", 3]) {
    s.set({ url });
    await expect(files.thumbnail(entry.path)).rejects.toThrow("Invalid thumbnail");
  }

  s.set({});
  expect(await files.customProperties()).toEqual([]);
  s.set({ custom_props: [{ id: "p", name: "Property", type: "string" }] });
  expect(await files.customProperties()).toHaveLength(1);

  for (const data of [
    { custom_props: 1 },
    { custom_props: [{ id: 1, name: "x", type: "string" }] },
    { custom_props: [{ id: "p", name: 3, type: "string" }] },
    { custom_props: [{ id: "p", name: "x", type: 3 }] },
  ]) {
    s.set(data);
    await expect(files.customProperties()).rejects.toThrow();
  }
});

it("computes file capabilities and pagination without manufacturing permission", () => {
  const full = {
    ...entry,
    owned: true,
    capability: btoa(String.fromCharCode(255, 255, 3)),
  };

  expect(fileActions(full)).toEqual({
    create: false,
    rename: true,
    copy: true,
    move: true,
    delete: true,
    restore: true,
    metadata: true,
    edit: true,
    download: true,
  });

  expect(fileActions({ ...full, type: 1 }).create).toBe(true);

  expect(fileActions({ ...full, path: "cloudreve://id@share/file" })).toMatchObject({
    create: false,
    rename: false,
    copy: false,
    move: false,
    delete: false,
    metadata: false,
    edit: false,
    download: true,
  });

  expect(fileActions(entry).delete).toBe(false);

  expect(nextPage({ page: 0, page_size: 2, total_items: 3 })).toEqual({
    page: 1,
  });

  expect(nextPage({ page: 1, page_size: 2, total_items: 3 })).toBeUndefined();
  expect(nextPage({ page: 0, page_size: 0, total_items: 3 })).toBeUndefined();
  expect(nextPage({ page: 0, page_size: 2 })).toBeUndefined();
  expect(nextPage({ page: 0, page_size: 2, total_items: 3, is_cursor: true })).toBeUndefined();

  expect(nextPage({ page: 0, page_size: 2, next_token: "next" })).toEqual({
    next_page_token: "next",
  });
});

it("moves user, capacity and avatar protocol ownership without platform persistence", async () => {
  const s = setup({ id: "u", nickname: "User" });
  const p = new Profile(s.client);

  expect(await p.userInfo("user/slash")).toEqual({ id: "u", nickname: "User" });
  expect(s.url()).toContain("user%2Fslash");

  for (const data of [
    { id: 1, nickname: "x" },
    { id: "u", nickname: null },
  ]) {
    s.set(data);
    await expect(p.userInfo("u")).rejects.toThrow();
    await expect(p.me()).rejects.toThrow();
  }

  s.set({ total: 100, used: 3, storage_pack_total: 0 });

  expect(await p.capacity()).toEqual({
    total: 100,
    used: 3,
    storage_pack_total: 0,
  });

  s.set({ total: 100, used: 3, free: 97 });
  expect(await p.capacity()).toMatchObject({ storage_pack_total: 0 });

  for (const total of [-1, "100", null]) {
    s.set({ total, used: 0, storage_pack_total: 0 });
    await expect(p.capacity()).rejects.toThrow();
  }

  s.set({ passwordless: true, two_fa_enabled: false, disable_view_sync: true });

  expect(await p.settings()).toEqual({
    version_retention_enabled: false,
    version_retention_ext: [],
    version_retention_max: 0,
    share_links_in_profile: "",
    passkeys: [],
    oauth_grants: [],
    passwordless: true,
    two_fa_enabled: false,
    disable_view_sync: true,
  });

  s.set({ passwordless: true, two_fa_enabled: false });
  await expect(p.settings()).rejects.toThrow();

  for (const [a, b] of [
    ["abc", "123456"],
    ["x".repeat(129), "123456"],
    ["abcd", "12345"],
    ["abcd", "x".repeat(129)],
  ]) {
    await expect(p.password(a!, b!)).rejects.toThrow();
  }

  s.set({ id: "u", nickname: "User" });
  await p.password("abcd", "123456");

  expect(s.body()).toEqual({
    current_password: "abcd",
    new_password: "123456",
  });

  await p.avatar(null);
  expect(s.transport.mock.calls.at(-2)?.[1]?.body).toBe("");

  for (const size of [0, -1, 1.5, 5 * 1024 * 1024 + 1]) {
    await expect(p.avatar({ size, chunk: vi.fn() })).rejects.toThrow();
  }

  await expect(p.avatar({ size: 1, chunk: vi.fn() }, "application/json")).rejects.toThrow();

  const dispose = vi.fn(async () => {});

  const source = {
    size: 1,
    chunk: vi.fn(async (_a, _b, _c, progress) => {
      progress();

      return { body: new Uint8Array([1]), dispose };
    }),
  };

  await p.avatar(source);
  expect(dispose).toHaveBeenCalledOnce();
  expect(avatarUrl("https://s/base", "u/x")).toBe("https://s/api/v4/user/avatar/u%2Fx");

  for (const url of ["file:///x", "https://u:p@s"]) {
    expect(() => avatarUrl(url, "u")).toThrow();
  }
});

it("extracts token-config, revocation and raw OAuth operations with response validation", async () => {
  let data: any = { user: { id: "u", nickname: "User" } };

  const transport = vi.fn(async (url: string) =>
    Response.json(url.includes("/oauth/") ? data : { code: 0, data }),
  );

  const a = new Authentication("https://s", transport);

  expect(await a.configForToken("token")).toMatchObject({ user: { id: "u" } });
  data = { siteName: "Site" };
  expect(await a.configForToken("token")).toEqual(data);
  await a.revokeRefreshToken("refresh");

  expect(JSON.parse(transport.mock.lastCall?.[1]?.body as string)).toEqual({
    refresh_token: "refresh",
  });

  const options = {
    code: "code",
    codeVerifier: "verifier",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "app://callback",
  };

  const token = {
    access_token: "a",
    refresh_token: "r",
    token_type: "Bearer",
    expires_in: 30,
    refresh_token_expires_in: 60,
    scope: "",
  };

  data = token;
  expect(await a.exchangeOAuthToken(options)).toEqual(token);

  expect(
    new URLSearchParams(transport.mock.lastCall?.[1]?.body as string).get("code_verifier"),
  ).toBe("verifier");

  for (const bad of [
    { ...token, access_token: "" },
    { ...token, expires_in: "x" },
    { ...token, expires_in: -1 },
    { ...token, refresh_token_expires_in: null },
    { ...token, scope: 1 },
  ]) {
    data = bad;
    await expect(a.exchangeOAuthToken(options)).rejects.toThrow();
  }

  data = { sub: "u", name: "User" };
  expect(await a.oauthUserInfo("access")).toEqual(data);
  data = { sub: "" };
  await expect(a.oauthUserInfo("access")).rejects.toThrow();
  await expect(a.configForToken("")).rejects.toThrow();
  await expect(a.revokeRefreshToken("")).rejects.toThrow();
});

it("validates shares, direct links and WebDAV boundaries", async () => {
  const share = {
    id: "s",
    visited: 0,
    url: "https://s/share",
    source_uri: "cloudreve://my/f",
    source_type: 1,
  };

  const s = setup(share);
  const shares = new Shares(s.client);

  expect(await shares.resolve("a/b", "password")).toEqual(share);
  expect(s.url()).toBe("https://server.test/api/v4/share/info/a%2Fb?password=password");
  await shares.resolve("s");
  expect(s.url()).toBe("https://server.test/api/v4/share/info/s");
  await shares.revoke("a/b");
  expect(s.url()).toContain("a%2Fb");
  await shares.revokeDirect("a/b");
  expect(s.url()).toContain("/file/source/a%2Fb");
  s.set({ user: { group: { direct_link_batch_size: 3 } } });
  expect(await shares.directAllowed()).toBe(true);
  s.set({ user: { group: {} } });
  expect(await shares.directAllowed()).toBe(false);

  for (const expires of [false, "bad"]) {
    s.set({ ...share, expires });
    await expect(shares.resolve("s")).rejects.toThrow("expiry");
  }

  s.set([{ link: "https://s/link" }]);

  expect(await shares.direct("cloudreve://my/f")).toEqual([
    { file_url: "", link: "https://s/link" },
  ]);

  expect(() => shareSourceUri({ ...share, source_uri: undefined } as any)).toThrow("unavailable");

  const dav = new WebDAV(s.client);

  for (const row of [
    { id: "", name: "x", uri: "cloudreve://my/", password: "p" },
    { id: "i", name: "x", uri: "cloudreve://my/", password: 1 },
  ]) {
    s.set({ accounts: [row] });
    await expect(dav.list()).rejects.toThrow("Invalid WebDAV");
  }

  s.set({ accounts: [] });
  expect((await dav.list()).pagination).toEqual({});

  for (const options of [
    { name: "", uri: "cloudreve://my/" },
    { name: "x".repeat(256), uri: "cloudreve://my/" },
    { name: "x", uri: "https://s/" },
    { name: "x", uri: "cloudreve://trash/" },
    { name: "x", uri: "cloudreve://my/?name=x" },
  ]) {
    await expect(dav.save(options)).rejects.toThrow();
  }
});

it("rejects malformed job and archive responses at protocol boundaries", async () => {
  const s = setup({ tasks: [], pagination: {} });
  const jobs = new Jobs(s.client);

  for (const row of [
    { id: "", type: "archive", status: TaskStatus.queued },
    { id: "t", type: 1, status: TaskStatus.queued },
    { id: "t", type: "archive", status: "nonsense" },
  ]) {
    s.set({ tasks: [row], pagination: {} });
    await expect(jobs.list(ListTaskCategory.general)).rejects.toThrow("Invalid server task");
  }

  s.set({ tasks: [], pagination: {} });

  await expect(jobs.get("missing", TaskType.remote_download)).rejects.toMatchObject({
    code: 404,
  });

  s.set({ files: [{ name: 1, size: 1, is_directory: false }] });
  await expect(jobs.archiveFiles("cloudreve://my/f")).rejects.toThrow("Invalid archive entry");
  s.set({ files: [{ name: "x", size: "1", is_directory: false }] });
  await expect(jobs.archiveFiles("cloudreve://my/f")).rejects.toThrow("Invalid archive entry");
  s.set({ files: [{ name: "x", size: 1, is_directory: 1 }] });
  await expect(jobs.archiveFiles("cloudreve://my/f")).rejects.toThrow("Invalid archive entry");
});
