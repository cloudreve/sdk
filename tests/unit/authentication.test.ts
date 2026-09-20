import { it, expect } from "vitest";
import { Authentication, parseCredentialLink, validateServerVersion } from "@cloudreve/sdk/session";

const token = {
  access_token: "a",
  refresh_token: "r",
  access_expires: "2030-01-01T00:00:00Z",
  refresh_expires: "2031-01-01T00:00:00Z",
};

const success = (data: unknown) => Response.json({ code: 0, data });

it("represents 2FA as a challenge, then validates the completed session", async () => {
  const auth = new Authentication("https://server.test", async (url, init) => {
    expect(init?.redirect).toBe("error");

    if (url.endsWith("/2fa")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        session_id: "otp-session",
        otp: "123456",
      });

      return success({ user: { id: "u", nickname: "User" }, token });
    }

    return Response.json({
      code: 203,
      data: "otp-session",
      msg: "2FA required",
    });
  });

  expect(await auth.password("u@example.test", "password")).toEqual({
    kind: "otp",
    sessionId: "otp-session",
  });

  expect((await auth.otp("otp-session", "123456")).user.id).toBe("u");
  await expect(auth.otp("otp-session", "bad")).rejects.toThrow("six-digit");
});

it("rejects malformed credentials and captcha documents", async () => {
  const auth = new Authentication("https://server.test", async (url) =>
    url.endsWith("/captcha")
      ? success({ image: "data:image/svg+xml,<script/>", ticket: "ticket" })
      : success({
          user: { id: "u", nickname: "User" },
          token: { ...token, access_expires: "invalid" },
        }),
  );

  await expect(auth.password("u@example.test", "password")).rejects.toThrow("expiration");
  await expect(auth.captcha()).rejects.toThrow("captcha image");
});

it("imports refresh credentials only at the reviewed origin and loads the matching profile", async () => {
  const calls: string[] = [];

  const auth = new Authentication("https://server.test", async (url, init) => {
    calls.push(url);

    if (url.endsWith("/refresh")) {
      return success(token);
    }

    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a");

    return success({
      user: {
        id: "u",
        nickname: "User",
        group: { id: "hashed", name: "Member", permission: "AQ==" },
      },
    });
  });

  expect((await auth.importRefreshToken("refresh")).user.group).toEqual({
    id: "hashed",
    name: "Member",
    permission: "AQ==",
  });

  expect(calls).toEqual([
    "https://server.test/api/v4/session/token/refresh",
    "https://server.test/api/v4/site/config/basic",
  ]);

  expect(parseCredentialLink("https://server.test/login?refresh_token=opaque")).toEqual({
    endpoint: "https://server.test",
    refreshToken: "opaque",
  });

  for (const bad of [
    "https://trusted.test@evil.test/login?refresh_token=x",
    "file:///login?refresh_token=x",
    "https://server.test/login?refresh_token=x&refresh_token=y",
  ]) {
    expect(() => parseCredentialLink(bad)).toThrow();
  }
});

it("accepts native-login V4 servers without advertising OAuth support", async () => {
  expect(await validateServerVersion("https://server.test", async () => success("4.11.0"))).toEqual(
    { version: "4.11.0", isPro: false },
  );

  await expect(
    validateServerVersion("https://server.test", async () => success("3.8.0")),
  ).rejects.toMatchObject({ type: "versionTooLow" });

  await expect(
    validateServerVersion("https://server.test", async () => success({ version: "4.12.0" })),
  ).rejects.toMatchObject({ type: "apiError" });
});

it("does not accept a response delivered after cancellation", async () => {
  const controller = new AbortController();

  const auth = new Authentication(
    "https://server.test",
    async () => {
      controller.abort();

      return success({ user: { id: "u", nickname: "User" }, token });
    },
    controller.signal,
  );

  await expect(auth.password("u@example.test", "password")).rejects.toThrow("cancelled");
});
