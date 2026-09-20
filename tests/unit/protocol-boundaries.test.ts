import { it, expect, vi } from "vitest";
import { ApiError, Boolset, record, request } from "@cloudreve/sdk/protocol";
import {
  AccountClient,
  Authentication,
  normalizeServerUrl,
  compareSemver,
  validateServerVersion,
  isValidationError,
  SiteValidationError,
  parseCredentialLink,
} from "@cloudreve/sdk/session";

const expiration = new Date(Date.now() + 3600000).toISOString();

const token = {
  access_token: "access",
  refresh_token: "refresh",
  access_expires: expiration,
  refresh_expires: expiration,
};

const profile = { id: "u", nickname: "User" };
const session = { user: profile, token };

const api = (data: unknown) => Response.json({ code: 0, data });

const auth = (data: unknown) => new Authentication("https://server.test", async () => api(data));

it("rejects non-record wire values and decodes bitsets safely", () => {
  for (const value of [null, undefined, 1, "x", [], false]) {
    expect(() => record(value)).toThrow(ApiError);
  }

  expect(record({ x: 1 })).toEqual({ x: 1 });
  expect(new Boolset().enabled(0)).toBe(false);
  expect(new Boolset("%%%").enabled(1)).toBe(false);
  expect(new Boolset(btoa(String.fromCharCode(1, 128))).enabled(15)).toBe(true);
  expect(new Boolset("AQ==").enabled(0)).toBe(true);
  expect(new Boolset("AQ==").enabled(8)).toBe(false);
});

it("preserves status failures, fallback messages and aggregate wire outcomes", async () => {
  for (const raw of [false, true]) {
    await expect(
      request(async () => new Response("", { status: 503 }), "https://s", {}, raw),
    ).rejects.toMatchObject({ code: 503, message: "HTTP 503" });

    await expect(
      request(
        async () => new Response("detail", { status: 503, statusText: "Unavailable" }),
        "https://s",
        {},
        raw,
      ),
    ).rejects.toMatchObject({
      message: raw ? "detail" : "HTTP 503: Unavailable",
    });
  }

  await expect(
    request(
      async () =>
        ({
          ...new Response(),
          ok: false,
          status: 500,
          text: async () => {
            throw Error("gone");
          },
        }) as any,
      "https://s",
      {},
      true,
    ),
  ).rejects.toMatchObject({ code: 500 });

  for (const envelope of [{}, { code: "0" }, null, []]) {
    await expect(request(async () => Response.json(envelope), "https://s")).rejects.toThrow(
      "Invalid server response",
    );
  }

  for (const [envelope, message] of [
    [{ code: 9 }, "Server operation failed"],
    [{ code: 9, msg: 1, error: "detail" }, "detail"],
    [{ code: 9, msg: "preferred", error: "detail" }, "preferred"],
  ] as const) {
    await expect(request(async () => Response.json(envelope), "https://s")).rejects.toMatchObject({
      code: 9,
      message,
    });
  }

  await expect(
    request(
      async () =>
        Response.json({
          code: 40081,
          aggregated_error: { x: { code: 403 } },
          correlation_id: "c",
        }),
      "https://s",
    ),
  ).rejects.toMatchObject({ data: { x: { code: 403 } }, correlationId: "c" });

  const transport = vi.fn(async () => api("ok"));

  expect(
    await request(transport, "https://s", {
      headers: { "Content-Type": "custom" },
    }),
  ).toBe("ok");

  expect(new Headers(transport.mock.calls[0]![1]?.headers).get("Content-Type")).toBe("custom");
});

it("normalizes servers and orders release and prerelease versions", () => {
  expect(normalizeServerUrl(" server.test/path/// ")).toBe("https://server.test/path");
  expect(normalizeServerUrl("HTTP://server.test/")).toBe("http://server.test");
  expect(() => normalizeServerUrl("https://name:pass@server.test")).toThrow();

  for (const [a, b, result] of [
    ["4.1.0", "4.1.0", 0],
    ["4.0.0", "4.1.0", -1],
    ["5.0.0", "4.9.0", 1],
    ["4.1.0-beta", "4.1.0", -1],
    ["4.1.0", "4.1.0-beta", 1],
    ["4.1.0-a", "4.1.0-b", -1],
    ["4.1.0-b", "4.1.0-a", 1],
    ["4.1.0-1", "4.1.0-a", -1],
    ["4.1.0-a", "4.1.0-1", 1],
    ["4.1.0-2", "4.1.0-1", 1],
    ["4.1.0-a.1", "4.1.0-a", 1],
    ["4.1.0-a", "4.1.0-a.1", -1],
    ["4.1.0-a.1", "4.1.0-a.1", 0],
  ] as const) {
    expect(compareSemver(a, b)).toBe(result);
  }

  for (const v of ["x", "4.x", "9007199254740992.0.0"]) {
    expect(() => compareSemver(v, "4.0.0")).toThrow("Invalid version");
  }

  expect(isValidationError(null)).toBe(false);
  expect(isValidationError({ type: "x" })).toBe(false);
  expect(isValidationError(new SiteValidationError("apiError", {}))).toBe(true);
  expect(new SiteValidationError("apiError", { message: "detail" }).message).toBe("detail");
});

it("distinguishes unsupported versions, transport failures and malformed ping replies", async () => {
  for (const [value, result] of [
    ["4.14.0", { version: "4.14.0", isPro: false }],
    ["4.14.0-pro", { version: "4.14.0", isPro: true }],
  ] as const) {
    expect(await validateServerVersion("https://s", async () => api(value))).toEqual(result);
  }

  await expect(validateServerVersion("https://s", async () => api("3.9.0"))).rejects.toMatchObject({
    type: "versionTooLow",
  });

  for (const value of [false, "garbage", "4.0.0%"]) {
    await expect(validateServerVersion("https://s", async () => api(value))).rejects.toMatchObject({
      type: "apiError",
    });
  }

  for (const msg of [undefined, "specific"]) {
    await expect(
      validateServerVersion("https://s", async () => Response.json({ code: 9, msg })),
    ).rejects.toMatchObject({
      type: "apiError",
      params: { message: msg ?? "Unknown error" },
    });
  }

  await expect(
    validateServerVersion("https://s", async () => new Response("", { status: 500 })),
  ).rejects.toMatchObject({ type: "httpError" });

  for (const error of [Error("offline"), "offline"]) {
    await expect(
      validateServerVersion("https://s", async () => {
        throw error;
      }),
    ).rejects.toMatchObject({ type: "connectionFailed" });
  }
});

it("validates authentication settings and request preparation", async () => {
  const settings = {
    login_captcha: true,
    forget_captcha: false,
    register_enabled: true,
    captcha_type: "image",
    captcha_ReCaptchaKey: "key",
    turnstile_site_id: "id",
    captcha_cap_instance_url: "url",
    captcha_cap_site_key: "key",
    captcha_cap_asset_server: "asset",
  };

  expect(await auth(settings).config()).toEqual(settings);
  expect(await auth({}).config()).toEqual({});

  for (const settings of [
    { login_captcha: "yes" },
    { forget_captcha: 1 },
    { captcha_type: 1 },
    { captcha_cap_site_key: "x".repeat(2049) },
  ]) {
    await expect(auth(settings).config()).rejects.toThrow("Invalid login settings");
  }

  expect(
    await auth({
      password_enabled: false,
      webauthn_enabled: true,
      oidc_enabled: true,
    }).prepare(" u "),
  ).toEqual({
    passwordEnabled: false,
    webAuthnEnabled: true,
    ssoEnabled: true,
  });

  expect(await auth({}).prepare("u")).toEqual({
    passwordEnabled: true,
    webAuthnEnabled: false,
    ssoEnabled: false,
  });

  expect(await auth({ sso_enabled: true }).prepare("u")).toMatchObject({
    ssoEnabled: true,
  });

  expect(await auth({ image: "data:image/png;base64,YQ==", ticket: "t" }).captcha()).toEqual({
    image: "data:image/png;base64,YQ==",
    ticket: "t",
  });

  for (const data of [
    { image: "https://s", ticket: "t" },
    { image: "", ticket: "t" },
    { image: "data:image/png;base64,YQ==", ticket: "" },
  ]) {
    await expect(auth(data).captcha()).rejects.toThrow();
  }

  const transport = vi.fn(async () => api(null));
  const a = new Authentication("https://s", transport);

  await a.resetPassword(" user ", { ticket: "t", captcha: "c" });

  expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({
    email: "user",
    ticket: "t",
    captcha: "c",
  });

  await expect(a.resetPassword(" ")).rejects.toThrow("email");

  for (const endpoint of ["file:///x", "https://u:p@s"]) {
    expect(() => new Authentication(endpoint, transport)).toThrow("Invalid server URL");
  }
});

it("validates complete user and token identities before exposing login sessions", async () => {
  const variants = [
    {
      ...profile,
      email: "a",
      avatar: "b",
      group: { id: 1, name: "g", permission: "AQ==" },
    },
    { ...profile, group: { id: "g", name: "g" } },
    { ...profile, group: { id: false, name: "g" } },
    { ...profile, group: { id: "g", name: 1 } },
  ];

  for (const user of variants) {
    expect((await auth({ user, token }).password("u", "pass")).kind).toBe("authenticated");
  }

  for (const user of [{ id: "u" }, { id: 1, nickname: "n" }, { id: "u", nickname: 2 }]) {
    await expect(auth({ user, token }).password("u", "pass")).rejects.toThrow();
  }

  for (const badToken of [
    { ...token, access_token: "" },
    { ...token, refresh_token: 1 },
    { ...token, access_expires: "bad" },
    { ...token, refresh_expires: "bad" },
  ]) {
    await expect(auth({ user: profile, token: badToken }).password("u", "pass")).rejects.toThrow();
  }

  for (const [email, password] of [
    ["", "pass"],
    ["u", "123"],
    ["u", "x".repeat(129)],
  ]) {
    await expect(auth(session).password(email!, password!)).rejects.toThrow();
  }

  for (const [sid, otp] of [
    ["", "123456"],
    ["s", "a23456"],
  ]) {
    await expect(auth(session).otp(sid!, otp!)).rejects.toThrow();
  }

  expect(await auth(session).otp("s", "123456")).toEqual(session);

  const a = new Authentication("https://s", async (url) =>
    api(url.includes("refresh") ? token : { user: profile }),
  );

  expect(await a.importRefreshToken("r")).toEqual(session);

  for (const value of ["", "x".repeat(16385)]) {
    await expect(a.importRefreshToken(value)).rejects.toThrow("Invalid refresh token");
  }

  for (const link of [
    "ftp://s?refresh_token=r",
    "https://u:p@s?refresh_token=r",
    "https://s?refresh_token=r#x",
    "https://s?refresh_token=r&refresh_token=a",
    "https://s?refresh_token=",
    "https://s?refresh_token=%20r",
    "https://s?refresh_token=" + "x".repeat(16385),
  ]) {
    expect(() => parseCredentialLink(link)).toThrow();
  }
});

it("does not refresh expired sessions or accept malformed refresh replacements", async () => {
  const transport = vi.fn(async () => api(token));

  expect(
    () =>
      new AccountClient({
        accountId: "u",
        endpoint: "ftp://s",
        transport,
        tokens: () => null,
        saveTokens: () => {},
      }),
  ).toThrow("Invalid server URL");

  const expired = {
    accessToken: "a",
    refreshToken: "r",
    accessExpiresAt: 0,
    refreshExpiresAt: 0,
  };

  const c = new AccountClient({
    accountId: "u",
    endpoint: "https://s",
    transport,
    tokens: () => expired,
    saveTokens: () => {},
  });

  await expect(c.request("/api/v4/file")).rejects.toThrow("Session expired");
  expect(transport).not.toHaveBeenCalled();

  for (const replacement of [
    { ...token, access_token: 4 },
    { ...token, refresh_token: "" },
    { ...token, access_expires: "bad" },
    { ...token, refresh_expires: "bad" },
  ]) {
    const save = vi.fn();

    const c = new AccountClient({
      accountId: "u",
      endpoint: "https://s",
      transport: async () => api(replacement),
      tokens: () => ({ ...expired, refreshExpiresAt: Date.now() + 100000 }),
      saveTokens: save,
    });

    await expect(c.request("/api/v4/file")).rejects.toThrow("Invalid token response");
    expect(save).not.toHaveBeenCalled();
  }
});

it("retains both successful batch data and per-item failures", async () => {
  const data = { done: ["a"] };
  const aggregated_error = { b: { code: 403, msg: "denied" } };

  await expect(
    request(async () => Response.json({ code: 40081, data, aggregated_error }), "https://s"),
  ).rejects.toMatchObject({ data, aggregatedError: aggregated_error });
});

it("refuses cancelled or credential-bearing requests and never replays consumed streams", async () => {
  const transport = vi.fn(async () => Response.json({ code: 401, msg: "expired" }));

  const c = new AccountClient({
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
  });

  const abort = new AbortController();

  abort.abort();

  await expect(c.request("/api/v4/file", { signal: abort.signal })).rejects.toMatchObject({
    code: 499,
  });

  for (const url of ["https://user@s/api/v4/file", "https://user:pass@s/api/v4/file"]) {
    await expect(c.request(url)).rejects.toThrow("Untrusted");
  }

  expect(transport).not.toHaveBeenCalled();

  await expect(
    c.request("/api/v4/file/content", {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    }),
  ).rejects.toMatchObject({ code: 401 });

  expect(transport).toHaveBeenCalledOnce();

  const interrupted = new AbortController();

  const c2 = new AccountClient({
    accountId: "u",
    endpoint: "https://s",
    transport: async () => {
      interrupted.abort();

      return Response.json({ code: 0, data: "late" });
    },
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 600000,
      refreshExpiresAt: Date.now() + 1200000,
    }),
    saveTokens: () => {},
  });

  await expect(c2.request("/api/v4/file", { signal: interrupted.signal })).rejects.toMatchObject({
    code: 499,
  });
});

it("identifies unsupported streamed directory responses instead of parsing them as JSON", async () => {
  const response = new Response("event:file\ndata:{}\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });

  await expect(request(async () => response, "https://s")).rejects.toThrow(
    "Streaming directory responses",
  );

  expect(response.bodyUsed).toBe(true);
});
