import { expect, it, vi } from "vitest";
import { AccountClient, Authentication } from "../../src/session/index";
import { Files } from "../../src/files/index";
import { Profile } from "../../src/profile/index";
import { Jobs } from "../../src/jobs/index";
import { Shares } from "../../src/shares/index";

const token = {
  access_token: "a",
  refresh_token: "r",
  access_expires: "2099-01-01T00:00:00Z",
  refresh_expires: "2099-02-01T00:00:00Z",
};

const user = { id: "u", nickname: "User" };

const credential = {
  id: "id",
  rawId: "aWQ",
  type: "public-key",
  response: { clientDataJSON: "e30" },
};

const passkey = { id: "id", name: "Device", created_at: "2026-01-01" };

const file = {
  id: "f",
  name: "Note.txt",
  path: "cloudreve://my/Note.txt",
  size: 0,
  type: 0,
};

function context() {
  let data: unknown = undefined;
  let code = 0;

  const calls: { url: string; init: RequestInit }[] = [];

  const transport = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });

    return Response.json({ code, data, msg: "denied" });
  });

  const client = new AccountClient({
    endpoint: "https://server.test",
    accountId: "u",
    transport,
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
  });

  return {
    client,
    calls,
    transport,
    set(value: unknown, error = 0) {
      data = value;
      code = error;
    },
    auth: new Authentication("https://server.test", transport),
    files: new Files(client),
    profile: new Profile(client),
    jobs: new Jobs(client),
    shares: new Shares(client),
  };
}

it("sends version, pin and view mutations once with exact payload and cancellation", async () => {
  const c = context();
  const options = { headers: { "X-Test": "1" } };

  await c.files.promoteVersion(file.path, "e", options);
  await c.files.deleteVersion(file.path, "e");
  await c.files.pin(file.path);
  await c.files.pin(file.path, "Named");
  await c.files.unpin(file.path);

  await c.files.patchView(file.path, {
    page_size: 50,
    order: "name",
    order_direction: "asc",
    view: "list",
    thumbnail: true,
    gallery_width: 100,
    columns: [{ type: 0, width: 100, props: { metadata_key: "tag:x" } }],
  });

  await c.files.patchView(file.path, null);

  expect(c.calls.map((v) => [new URL(v.url).pathname, v.init.method])).toEqual([
    ["/api/v4/file/version/current", "POST"],
    ["/api/v4/file/version", "DELETE"],
    ["/api/v4/file/pin", "PUT"],
    ["/api/v4/file/pin", "PUT"],
    ["/api/v4/file/pin", "DELETE"],
    ["/api/v4/file/view", "PATCH"],
    ["/api/v4/file/view", "PATCH"],
  ]);

  expect(JSON.parse(String(c.calls[0]!.init.body))).toEqual({
    uri: file.path,
    version: "e",
  });

  expect(JSON.parse(String(c.calls[6]!.init.body))).toEqual({
    uri: file.path,
    view: null,
  });

  const signal = AbortSignal.abort();

  await expect(c.files.pin(file.path, "", signal)).rejects.toThrow("cancel");
  c.set(null, 40003);
  await expect(c.files.promoteVersion(file.path, "e")).rejects.toThrow("denied");
  await expect(c.files.deleteVersion(file.path, "")).rejects.toThrow("version");
  await expect(c.files.patchView(file.path, { page_size: 1 })).rejects.toThrow("view");
});

it("validates FTS and configured viewer results without assuming capabilities", async () => {
  const c = context();

  c.set({ hits: [{ file, content: "snippet" }], total: 1 });
  expect((await c.files.fullTextSearch("words", 2)).hits[0]!.content).toBe("snippet");
  expect(new URL(c.calls[0]!.url).searchParams.get("offset")).toBe("2");
  c.set({ hits: null, total: 0 });
  expect((await c.files.fullTextSearch("empty")).hits).toEqual([]);
  await expect(c.files.fullTextSearch("", 0)).rejects.toThrow();
  await expect(c.files.fullTextSearch("x", -1)).rejects.toThrow();
  c.set({ hits: [{ file: { id: "bad" } }], total: 1 });
  await expect(c.files.fullTextSearch("x")).rejects.toThrow();

  const result = {
    session: { id: "s", access_token: "secret", expires: 1 },
    wopi_src: "https://office.test",
  };

  c.set(result);

  expect(
    await c.files.viewerSession({
      uri: file.path,
      viewer_id: "office",
      preferred_action: "edit",
    }),
  ).toEqual(result);

  c.set({ session: { id: "s" } });

  await expect(
    c.files.viewerSession({
      uri: file.path,
      viewer_id: "v",
      preferred_action: "view",
    }),
  ).rejects.toThrow("session");
});

it("keeps preference patches separate from security ceremonies and validates settings", async () => {
  const c = context();

  await c.profile.patchSettings({
    language: "en",
    preferred_theme: "#ffffff",
    version_retention_enabled: true,
    version_retention_ext: ["txt"],
    version_retention_max: 2,
    disable_view_sync: false,
    share_links_in_profile: "all",
  });

  expect(JSON.parse(String(c.calls[0]!.init.body))).toMatchObject({
    version_retention_max: 2,
  });

  await expect(
    c.profile.patchSettings({
      current_password: "old",
      new_password: "newpass",
    } as never),
  ).rejects.toThrow("preferences");

  await expect(c.profile.patchSettings({})).rejects.toThrow("preferences");
  await c.profile.setTwoFactor(true, "123456");
  await c.profile.setTwoFactor(false, "123456");

  expect(JSON.parse(String(c.calls.at(-1)!.init.body))).toEqual({
    two_fa_enabled: false,
    two_fa_code: "123456",
  });

  c.set("SECRET");
  expect(await c.profile.initTwoFactor()).toBe("SECRET");

  c.set({
    passwordless: false,
    two_fa_enabled: false,
    disable_view_sync: false,
  });

  expect(await c.profile.settings()).toMatchObject({
    passkeys: [],
    oauth_grants: [],
    version_retention_max: 0,
  });

  c.set({
    passwordless: false,
    two_fa_enabled: false,
    disable_view_sync: false,
    passkeys: [passkey],
    oauth_grants: [
      {
        client_id: "c",
        client_name: "App",
        client_logo: "",
        scopes: ["openid"],
        last_used_at: null,
      },
    ],
  });

  expect((await c.profile.settings()).passkeys).toEqual([passkey]);
  c.set({ passwordless: false, two_fa_enabled: 0, disable_view_sync: false });
  await expect(c.profile.settings()).rejects.toThrow("settings");
  await expect(c.profile.patchSettings({ version_retention_max: -1 })).rejects.toThrow();
  await expect(c.profile.setTwoFactor(true, "")).rejects.toThrow();
});

it("bridges passkey registration and OAuth consent as data without platform globals", async () => {
  const c = context();

  const options = {
    publicKey: { challenge: "challenge", rp: { id: "server.test" } },
  };

  c.set(options);
  expect(await c.profile.beginPasskeyRegistration()).toEqual(options);
  c.set(passkey);

  expect(
    await c.profile.finishPasskeyRegistration({
      name: "Device",
      ua: "Native",
      response: credential,
    }),
  ).toEqual(passkey);

  expect(JSON.parse(String(c.calls.at(-1)!.init.body)).response).toBe(JSON.stringify(credential));
  await c.profile.deletePasskey("+/id=");
  expect(new URL(c.calls.at(-1)!.url).searchParams.get("id")).toBe("+/id=");
  await c.profile.revokeGrant("client/id");
  expect(c.calls.at(-1)!.url).toContain("client%2Fid");
  c.set({ id: "app", name: "App" });
  expect((await c.profile.oauthApplication("app")).consented_scopes).toEqual([]);
  c.set({ code: "authorization", state: "state" });

  expect(
    await c.profile.consentOAuth({
      client_id: "app",
      response_type: "code",
      redirect_uri: "https://client.test/callback",
      scope: "openid",
      state: "state",
    }),
  ).toEqual({ code: "authorization", state: "state" });

  c.set([user]);
  expect(await c.profile.searchUsers("Us")).toEqual([user]);
  await expect(c.profile.searchUsers("x")).rejects.toThrow();

  await expect(
    c.profile.finishPasskeyRegistration({ name: "", ua: "", response: {} }),
  ).rejects.toThrow();
});

it("handles registration email outcomes, signed activation and reset redemption", async () => {
  const c = context();

  c.set(user);

  expect(await c.auth.register({ email: "a@example.test", password: "password" })).toMatchObject({
    status: "active",
    user,
  });

  for (const code of [203, 40033]) {
    c.set(null, code);

    expect(await c.auth.register({ email: "a@example.test", password: "password" })).toEqual({
      status: "activationRequired",
    });
  }

  c.set(null, 40001);

  await expect(c.auth.register({ email: "a@example.test", password: "password" })).rejects.toThrow(
    "denied",
  );

  c.set(user);
  await c.auth.activate("https://server.test/api/v4/user/activate/u?sign=opaque");
  expect(c.calls.at(-1)!.url).toContain("?sign=opaque");

  for (const url of [
    "https://other.test/api/v4/user/activate/u",
    "https://server.test/api/v4/file",
    "https://u:p@server.test/api/v4/user/activate/u",
    "https://server.test/api/v4/user/activate/u#x",
  ]) {
    await expect(c.auth.activate(url)).rejects.toThrow("activation");
  }

  expect(await c.auth.redeemPasswordReset("u", "secret", "password")).toMatchObject(user);
  await expect(c.auth.redeemPasswordReset("u", "", "password")).rejects.toThrow();
  await expect(c.auth.register({ email: "bad", password: "x" })).rejects.toThrow();
});

it("handles discoverable passkey login and registration captcha configuration", async () => {
  const c = context();

  c.set({ session_id: "s", options: { publicKey: { challenge: "c" } } });
  expect((await c.auth.beginPasskeyLogin()).session_id).toBe("s");
  c.set({ user, token });

  expect(await c.auth.finishPasskeyLogin("s", credential)).toMatchObject({
    user,
    token,
  });

  await expect(c.auth.finishPasskeyLogin("s", {})).rejects.toThrow();
  c.set({ reg_captcha: true });
  expect((await c.auth.config()).reg_captcha).toBe(true);
  c.set({ reg_captcha: "true" });
  await expect(c.auth.config()).rejects.toThrow();
});

it("creates mutually exclusive remote URL/torrent tasks and batch share operations", async () => {
  const c = context();

  const task = {
    id: "t",
    type: "remote_download",
    status: "queued",
    created_at: "date",
  };

  c.set([task]);

  expect(
    await c.jobs.createDownload({
      src: ["https://remote.test/file"],
      dst: "cloudreve://my/",
    }),
  ).toEqual([task]);

  await c.jobs.createDownload({
    src_file: "cloudreve://my/file.torrent",
    dst: "cloudreve://my/",
  });

  for (const input of [
    { dst: "x" },
    { dst: "x", src: ["url"], src_file: "torrent" },
    { dst: "x", src: [""] },
    { dst: "", src: ["url"] },
  ]) {
    await expect(c.jobs.createDownload(input)).rejects.toThrow();
  }

  await expect(c.jobs.createDownload({ src: "url", dst: "x" } as never)).rejects.toMatchObject({
    kind: "validation",
  });

  c.set({});
  await expect(c.jobs.createDownload({ src: ["url"], dst: "x" })).rejects.toThrow("response");
  await c.shares.revokeMany(["a", "b"]);

  expect(JSON.parse(String(c.calls.at(-1)!.init.body))).toEqual({
    ids: ["a", "b"],
  });

  await expect(c.shares.revokeMany([])).rejects.toThrow();
  await expect(c.shares.revokeMany([""])).rejects.toThrow();

  c.set({
    shares: [{ id: "s", visited: 0, url: "https://server.test/s/s" }],
    pagination: { page: 0, page_size: 50 },
  });

  expect(
    (
      await c.shares.publicList("u", {
        page_size: 10,
        next_page_token: undefined,
      })
    ).shares,
  ).toHaveLength(1);

  c.set({ shares: null, pagination: {} });
  expect((await c.shares.publicList("u")).shares).toEqual([]);
  c.set({ shares: 3, pagination: {} });
  await expect(c.shares.publicList("u")).rejects.toThrow();
  await expect(c.shares.publicList("")).rejects.toThrow();
});

it("parses only unique same-origin backend recovery links", async () => {
  const c = context();

  c.set(user);
  await c.auth.activate("https://server.test/session/activate?id=u&sign=signed%2Bvalue");

  expect(c.calls.at(-1)!.url).toBe(
    "https://server.test/api/v4/user/activate/u?sign=signed%2Bvalue",
  );

  expect(
    await c.auth.redeemPasswordResetLink(
      "https://server.test/session/reset?id=u&secret=opaque",
      "password",
    ),
  ).toMatchObject(user);

  for (const link of [
    "https://server.test/session/activate?id=u&sign=",
    "https://server.test/session/activate?id=u&id=b&sign=s",
    "https://server.test/api/v4/user/activate/u",
  ]) {
    await expect(c.auth.activate(link)).rejects.toThrow("link");
  }

  for (const link of [
    "https://other.test/session/reset?id=u&secret=s",
    "https://a:b@server.test/session/reset?id=u&secret=s",
    "https://server.test/session/reset?id=u&secret=s#x",
    "https://server.test/other?id=u&secret=s",
    "https://server.test/session/reset?id=u&secret=s&secret=x",
  ]) {
    await expect(c.auth.redeemPasswordResetLink(link, "password")).rejects.toThrow("link");
  }
});

it("negotiates temporary selection ZIP without persisted archive workflow", async () => {
  const c = context();

  c.set({ urls: [{ url: "/api/v4/file/archive/s/archive.zip?sign=s" }] });

  expect(await c.files.archiveUrl([file.path])).toBe(
    "https://server.test/api/v4/file/archive/s/archive.zip?sign=s",
  );

  expect(JSON.parse(String(c.calls[0]!.init.body))).toEqual({
    uris: [file.path],
    archive: true,
    download: true,
  });

  await expect(c.files.archiveUrl([])).rejects.toThrow("Select");
  c.set({ urls: [] });
  await expect(c.files.archiveUrl([file.path])).rejects.toThrow("archive URL");
});

it("roundtrips metadata match operators and clears all prior metadata filters", async () => {
  const { CrUri } = await import("../../src/files/index");

  const uri = CrUri.my.withSearchParams({
    name: ["note"],
    nameOpOr: true,
    useOr: true,
    metadata: [
      { key: "tag:work", value: "", exact: true },
      { key: "props:a", value: "hello" },
    ],
  });

  expect(uri.isSearch()).toBe(true);

  expect(uri.searchParams()).toEqual({
    name: ["note"],
    nameOpOr: true,
    useOr: true,
    metadata: [
      { key: "tag:work", value: "", exact: true },
      { key: "props:a", value: "hello", exact: false },
    ],
  });

  const justMeta = new CrUri("cloudreve://my/?meta_tag%3Aa=x");

  expect(justMeta.isSearch()).toBe(true);
  expect(justMeta.withSearchParams({}).isSearch()).toBe(false);
  expect(uri.withSearchParams({}).searchParams()).toBeUndefined();
});

it("normalizes complete view defaults and validates saved pin presentation", async () => {
  const c = context();

  await c.files.patchView(file.path, { page_size: 50 });

  expect(JSON.parse(String(c.calls[0]!.init.body)).view).toEqual({
    page_size: 50,
    view: "list",
    order_direction: "asc",
    gallery_width: 200,
  });

  c.set({
    ...user,
    pined: [{ uri: file.path, name: "Note" }],
    language: "en",
    preferred_theme: "#ffffff",
  });

  expect(await c.profile.pins()).toEqual([{ uri: file.path, name: "Note" }]);
  c.set(user);
  expect(await c.profile.pins()).toEqual([]);
  c.set({ ...user, pined: [{ uri: 4 }] });
  await expect(c.profile.me()).rejects.toThrow("profile");
});

it("discovers configured viewers and rejects malformed viewer data", async () => {
  const c = context();

  const viewer = {
    id: "office",
    type: "wopi",
    display_name: "Office",
    exts: ["docx"],
    url: "https://office.test",
    disabled: false,
  };

  c.set({ file_viewers: [{ viewers: [viewer] }, { viewers: null }] });
  expect(await c.files.viewers()).toEqual([viewer]);
  c.set({});
  expect(await c.files.viewers()).toEqual([]);
  c.set({ file_viewers: [{ viewers: [{ id: "bad" }] }] });
  await expect(c.files.viewers()).rejects.toThrow("configuration");
});

it("requests primary-site URLs for configured viewers", async () => {
  const c = context();

  c.set({ urls: [{ url: "https://public.test/source" }] });
  expect(await c.files.viewerUrl(file.path, "e")).toBe("https://public.test/source");

  expect(JSON.parse(String(c.calls[0]!.init.body))).toEqual({
    uris: [file.path],
    entity: "e",
    use_primary_site_url: true,
  });

  c.set({ urls: [] });
  await expect(c.files.viewerUrl(file.path)).rejects.toThrow("viewer source");
});

it("parses same-origin OAuth authorization requests without approval or duplicate ambiguity", async () => {
  const { parseOAuthAuthorizationLink } = await import("../../src/session/index");

  const params = new URLSearchParams({
    client_id: "c",
    response_type: "code",
    redirect_uri: "org.cloudreve.android://oauth/callback",
    scope: "openid",
    state: "s",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });

  const url = "https://server.test/session/authorize?" + params;

  expect(parseOAuthAuthorizationLink(url, "https://server.test")).toMatchObject({
    client_id: "c",
    state: "s",
  });

  expect(() => parseOAuthAuthorizationLink(url + "&state=other", "https://server.test")).toThrow(
    "Duplicate",
  );

  expect(() => parseOAuthAuthorizationLink(url, "https://other.test")).toThrow();

  const unsafe = new URL(url);

  unsafe.searchParams.set("redirect_uri", "file:///tmp/callback");
  expect(() => parseOAuthAuthorizationLink(unsafe.toString(), "https://server.test")).toThrow();
  params.set("code_challenge", "short");

  expect(() =>
    parseOAuthAuthorizationLink(
      "https://server.test/session/authorize?" + params,
      "https://server.test",
    ),
  ).toThrow("PKCE");

  params.delete("code_challenge");

  expect(() =>
    parseOAuthAuthorizationLink(
      "https://server.test/session/authorize?" + params,
      "https://server.test",
    ),
  ).toThrow("PKCE");

  params.delete("code_challenge_method");

  expect(
    parseOAuthAuthorizationLink(
      "https://server.test/session/authorize?" + params,
      "https://server.test",
    ).client_id,
  ).toBe("c");
});

it("preserves validated binary version preconditions in upload creation and checkpoints", async () => {
  const { Uploads } = await import("../../src/transfers/index");
  const c = context();
  const uploads = new Uploads(c.client, c.transport);

  c.set({
    session_id: "s",
    uri: file.path,
    expires: Date.now() + 10000,
    chunk_size: 1,
    upload_urls: [],
    credential: "",
    completeURL: "",
    callback_secret: "",
  });

  const spec = {
    uri: file.path,
    size: 1,
    policy_id: "p",
    entity_type: "version" as const,
    previous: "entity",
    metadata: { "tag:work": "#ffffff" },
  };

  const job = await uploads.create(spec, "local");

  expect(job.spec).toMatchObject(spec);

  expect(JSON.parse(String(c.calls[0]!.init.body))).toMatchObject({
    entity_type: "version",
    previous: "entity",
    metadata: spec.metadata,
  });

  await expect(uploads.create({ ...spec, entity_type: "bad" } as never, "local")).rejects.toThrow();
  await expect(uploads.create({ ...spec, previous: "" }, "local")).rejects.toThrow();
});

it("passes total-deadline cancellation into upload and avatar chunk producers", async () => {
  const { Uploads } = await import("../../src/transfers/index");

  const c = context();
  const uploads = new Uploads(c.client, c.transport);

  c.set({
    session_id: "s",
    uri: file.path,
    expires: Date.now() + 10000,
    chunk_size: 1,
    upload_urls: [],
    credential: "",
    completeURL: "",
    callback_secret: "",
  });

  const job = await uploads.create({ uri: file.path, size: 1, policy_id: "p" }, "local");
  let aborted = 0;

  const source = {
    size: 1,
    chunk: async (
      _start: number,
      _end: number,
      _encryption: unknown,
      _progress: unknown,
      signal?: AbortSignal,
    ): Promise<never> =>
      new Promise((_resolve, reject) => {
        expect(signal).toBeDefined();

        signal!.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(signal!.reason);
          },
          { once: true },
        );
      }),
  };

  await expect(
    uploads.run(
      job,
      source,
      async () => {},
      () => {},
      new AbortController().signal,
      { timeoutMs: 2 },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });

  await expect(c.profile.avatar(source, "image/png", { timeoutMs: 2 })).rejects.toMatchObject({
    kind: "timeout",
  });

  expect(aborted).toBe(2);
});
