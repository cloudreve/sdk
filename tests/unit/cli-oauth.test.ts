import { describe, expect, it, vi } from "vitest";
import {
  Authentication,
  CLI_OAUTH_CLIENT,
  createCliOAuthAuthorizationUrl,
} from "@cloudreve/sdk/session";
import { ApiError } from "@cloudreve/sdk/protocol";

const endpoint = "https://cloud.example.test";
const state = "caller-generated-state";
const challenge = "a".repeat(43);

const redirectUri = "http://127.0.0.1:49152/callback";

it("builds CLI consent with the bound loopback redirect and S256", () => {
  const url = new URL(
    createCliOAuthAuthorizationUrl(endpoint + "/", { state, challenge, redirectUri }),
  );

  expect(url.origin + url.pathname).toBe(endpoint + "/session/authorize");

  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: CLI_OAUTH_CLIENT.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope:
      "profile email openid offline_access UserInfo.Write Workflow.Write Files.Write Shares.Write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  expect(CLI_OAUTH_CLIENT.redirectUri).toBe("http://127.0.0.1/callback");
  expect(Object.isFrozen(CLI_OAUTH_CLIENT)).toBe(true);
});

it("rejects malformed servers, state, and PKCE challenges before browser navigation", () => {
  for (const endpoint of [
    "file:///tmp/server",
    "https://user@server.test",
    "https://user:pass@server.test",
  ]) {
    expect(() =>
      createCliOAuthAuthorizationUrl(endpoint, { state, challenge, redirectUri }),
    ).toThrow("server URL");
  }

  for (const state of ["", " ", "state\n", "state\0", "s".repeat(4097)]) {
    expect(() =>
      createCliOAuthAuthorizationUrl(endpoint, { state, challenge, redirectUri }),
    ).toThrow("state");
  }

  for (const challenge of ["", "a".repeat(42), "a".repeat(43) + "\n", "!".repeat(43)]) {
    expect(() =>
      createCliOAuthAuthorizationUrl(endpoint, { state, challenge, redirectUri }),
    ).toThrow("PKCE");
  }
});

it("requires a bound loopback port and rejects other authorities or callback paths", () => {
  for (const port of [1, 80, 49152, 65535]) {
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const url = new URL(
      createCliOAuthAuthorizationUrl(endpoint, { state, challenge, redirectUri }),
    );

    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
  }

  for (const redirectUri of [
    "http://127.0.0.1/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:01/callback",
    "https://127.0.0.1:49152/callback",
    "http://localhost:49152/callback",
    "http://127.0.0.2:49152/callback",
    "http://[::1]:49152/callback",
    "http://example.test:49152/callback",
    "http://user@127.0.0.1:49152/callback",
    "http://127.0.0.1:49152/other",
    "http://127.0.0.1:49152/callback?",
    "http://127.0.0.1:49152/callback#",
    "http://127.0.0.1:49152/callback\n",
    "http://127.0.0.1:49152/callback?code=x",
    "http://127.0.0.1:49152/callback#code=x",
    "not a URL",
  ]) {
    expect(() =>
      createCliOAuthAuthorizationUrl(endpoint, { state, challenge, redirectUri }),
    ).toThrow("loopback");
  }
});

describe("CLI OAuth capability discovery", () => {
  it("validates anonymous application metadata using the requested deadline and cancellation", async () => {
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(endpoint + "/api/v4/session/oauth/app/" + CLI_OAUTH_CLIENT.clientId);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);

      return Response.json({
        code: 0,
        data: { id: CLI_OAUTH_CLIENT.clientId, name: "Cloudreve CLI" },
      });
    });

    const auth = new Authentication(endpoint, transport);

    expect(await auth.cliOAuthApplication({ timeoutMs: 1000 })).toMatchObject({
      name: "Cloudreve CLI",
      consented_scopes: [],
    });

    const cancelled = new AbortController();

    cancelled.abort();

    await expect(auth.cliOAuthApplication(cancelled.signal)).rejects.toMatchObject({
      kind: "cancelled",
    });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reports only actual missing applications as unavailable", async () => {
    for (const response of [
      Response.json({ code: 404, msg: "App not found" }),
      new Response("Not found", { status: 404 }),
    ]) {
      const auth = new Authentication(endpoint, async () => response);

      await expect(auth.cliOAuthApplication()).rejects.toMatchObject({
        kind: "unsupported",
        code: 404,
        cause: expect.any(ApiError),
      });
    }

    for (const response of [
      Response.json({ code: 0, data: { id: 1, name: "bad" } }),
      Response.json({ code: 40004, msg: "Other backend failure" }),
      new Response("Forbidden", { status: 403 }),
    ]) {
      const auth = new Authentication(endpoint, async () => response);

      await expect(auth.cliOAuthApplication({ retry: "never" })).rejects.not.toMatchObject({
        kind: "unsupported",
      });
    }

    const auth = new Authentication(endpoint, async () => {
      throw new Error("offline");
    });

    await expect(auth.cliOAuthApplication({ retry: "never" })).rejects.toMatchObject({
      kind: "transport",
    });
  });
});
