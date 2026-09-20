import { CLI_OAUTH_CLIENT } from "./cli-oauth.ts";
import * as v from "valibot";
import { nonempty } from "../protocol/index.ts";
import {
  OAuthApplicationSchema,
  type OAuthApplication,
  CredentialOptionsSchema,
  CredentialResponseSchema,
  type CredentialOptions,
} from "./ceremony.ts";

/** @public */
export interface RegistrationInput extends CaptchaAnswer {
  email: string;
  password: string;
  language?: string;
}

/** @public */
export type RegistrationResult =
  { status: "active"; user: SiteConfigUser } | { status: "activationRequired" };

import {
  withDeadline,
  toRequestOptions,
  type CallOptions,
  type RequestOptions,
} from "../protocol/index.ts";
import { PasswordTokenSchema, OAuthTokenSchema } from "./tokens.ts";
import { decode } from "../protocol/index.ts";
import { ApiError, record, request, type Transport } from "../protocol/index.ts";
import type {
  PasswordLoginResponse,
  PasswordLoginToken,
  SiteConfigUser,
  SiteConfig,
  OAuthTokenResponse,
  OAuthUserInfoResponse,
} from "./auth-types.ts";

/** @public */
export type LoginResult =
  { kind: "authenticated"; session: PasswordLoginResponse } | { kind: "otp"; sessionId: string };

/** @public */
export interface LoginConfig {
  login_captcha?: boolean;
  reg_captcha?: boolean;
  forget_captcha?: boolean;
  captcha_type?: string;
  captcha_ReCaptchaKey?: string;
  turnstile_site_id?: string;
  captcha_cap_instance_url?: string;
  captcha_cap_site_key?: string;
  captcha_cap_asset_server?: string;
  register_enabled?: boolean;
}

/** @public */
export interface CaptchaAnswer {
  captcha?: string;
  ticket?: string;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new ApiError(-1, "Invalid authentication response");
  }

  return value;
}

function tokens(value: unknown): PasswordLoginToken {
  return decode(PasswordTokenSchema, value, "Invalid token expiration or authentication response");
}

function user(value: unknown): SiteConfigUser {
  const data = record(value);
  const id = string(data.id);

  if (typeof data.nickname !== "string") {
    throw new ApiError(-1, "Invalid account profile");
  }

  const group = data.group ? record(data.group) : undefined;

  return {
    id,
    nickname: data.nickname,
    email: typeof data.email === "string" ? data.email : undefined,
    avatar: typeof data.avatar === "string" ? data.avatar : undefined,
    group:
      group &&
      (typeof group.id === "number" || typeof group.id === "string") &&
      typeof group.name === "string"
        ? {
            id: group.id,
            name: group.name,
            permission: typeof group.permission === "string" ? group.permission : undefined,
          }
        : undefined,
  };
}

function session(value: unknown): PasswordLoginResponse {
  const data = record(value);

  return { user: user(data.user), token: tokens(data.token) };
}

/** Unauthenticated protocol operations. No account is persisted until a complete session exists. */
/** Unauthenticated sign-in and account recovery operations for one server. @public */
export class Authentication {
  readonly endpoint: string;

  constructor(
    endpoint: string,
    private transport: Transport,
    private signal?: AbortSignal,
  ) {
    const url = new URL(endpoint);

    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new ApiError(-1, "Invalid server URL");
    }

    this.endpoint = url.origin;
  }

  private call<T>(path: string, init: RequestOptions = {}, raw = false) {
    return request<T>(
      this.transport,
      new URL("/api/v4/" + path, this.endpoint).toString(),
      {
        ...init,
        retry: init.method && !["GET", "HEAD"].includes(init.method) ? "never" : init.retry,
        redirect: "error",
      },
      raw,
    );
  }

  private ceremony<T>(
    path: string,
    method: string,
    body: unknown,
    options?: CallOptions,
  ): Promise<T> {
    const normalized = toRequestOptions(options);

    return withDeadline(
      (signal) =>
        this.call<T>(path, {
          ...normalized,
          signal,
          timeoutMs: 0,
          retry: "never",
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      normalized,
      this.signal,
    );
  }

  async register(input: RegistrationInput, options?: CallOptions): Promise<RegistrationResult> {
    const value = decode(
      v.object({
        email: v.pipe(nonempty, v.email()),
        password: v.pipe(v.string(), v.minLength(6), v.maxLength(128)),
        language: v.optional(v.string()),
        captcha: v.optional(v.string()),
        ticket: v.optional(v.string()),
      }),
      input,
      "Invalid registration",
    );

    try {
      return {
        status: "active",
        user: user(await this.ceremony("user", "POST", value, options)),
      };
    } catch (error) {
      if (error instanceof ApiError && [203, 40033].includes(error.code)) {
        return { status: "activationRequired" };
      }

      throw error;
    }
  }

  async activate(link: string, options?: CallOptions): Promise<void> {
    const url = new URL(link);

    if (url.origin !== this.endpoint || url.username || url.password || url.hash) {
      throw new ApiError(-1, "Invalid activation link");
    }

    if (url.pathname === "/session/activate") {
      const id = this.linkParameter(url, "id");
      const sign = this.linkParameter(url, "sign");

      url.pathname = `/api/v4/user/activate/${encodeURIComponent(id)}`;
      url.search = new URLSearchParams({ sign }).toString();
    }

    if (!/^\/api\/v4\/user\/activate\/[^/]+$/.test(url.pathname)) {
      throw new ApiError(-1, "Invalid activation link");
    }

    this.linkParameter(url, "sign");

    await this.ceremony(
      url.pathname.slice("/api/v4/".length) + url.search,
      "GET",
      undefined,
      options,
    );
  }

  private linkParameter(url: URL, key: string): string {
    const values = url.searchParams.getAll(key);

    if (values.length !== 1 || !values[0]) {
      throw new ApiError(-1, "Invalid account recovery link");
    }

    return values[0];
  }

  async redeemPasswordResetLink(
    link: string,
    password: string,
    options?: CallOptions,
  ): Promise<SiteConfigUser> {
    const url = new URL(link);

    if (
      url.origin !== this.endpoint ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/session/reset"
    ) {
      throw new ApiError(-1, "Invalid password reset link");
    }

    return this.redeemPasswordReset(
      this.linkParameter(url, "id"),
      this.linkParameter(url, "secret"),
      password,
      options,
    );
  }

  async redeemPasswordReset(
    userId: string,
    secret: string,
    password: string,
    options?: CallOptions,
  ): Promise<SiteConfigUser> {
    const body = {
      secret: decode(nonempty, secret, "Invalid reset secret"),
      password: decode(
        v.pipe(v.string(), v.minLength(6), v.maxLength(128)),
        password,
        "Invalid password",
      ),
    };

    return user(
      await this.ceremony(
        `user/reset/${encodeURIComponent(decode(nonempty, userId, "Invalid user ID"))}`,
        "PATCH",
        body,
        options,
      ),
    );
  }

  async beginPasskeyLogin(
    options?: CallOptions,
  ): Promise<{ session_id: string; options: CredentialOptions }> {
    return decode(
      v.object({ session_id: nonempty, options: CredentialOptionsSchema }),
      await this.ceremony("session/authn", "PUT", undefined, options),
      "Invalid passkey login options",
    );
  }

  async finishPasskeyLogin(
    sessionId: string,
    response: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<PasswordLoginResponse> {
    return session(
      await this.ceremony(
        "session/authn",
        "POST",
        {
          session_id: decode(nonempty, sessionId, "Invalid passkey session"),
          response: JSON.stringify(
            decode(CredentialResponseSchema, response, "Invalid passkey response"),
          ),
        },
        options,
      ),
    );
  }

  async configForToken(accessToken: string, operationOptions?: CallOptions): Promise<SiteConfig> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const data = record(
          await this.call("site/config/basic", {
            ...nestedOptions,
            headers: { Authorization: `Bearer ${string(accessToken)}` },
          }),
        );

        return {
          ...data,
          ...(data.user ? { user: user(data.user) } : {}),
        } as SiteConfig;
      },
      normalized,
      this.signal,
    );
  }

  async revokeRefreshToken(refreshToken: string, operationOptions?: CallOptions): Promise<void> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        await this.call("session/token", {
          ...nestedOptions,
          method: "DELETE",
          body: JSON.stringify({ refresh_token: string(refreshToken) }),
        });
      },
      normalized,
      this.signal,
    );
  }

  /** Discover built-in CLI OAuth support without inferring it from the server version. */
  async cliOAuthApplication(operationOptions?: CallOptions): Promise<OAuthApplication> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        try {
          return decode(
            OAuthApplicationSchema,
            await this.call(`session/oauth/app/${CLI_OAUTH_CLIENT.clientId}`, {
              ...normalized,
              signal,
              timeoutMs: 0,
            }),
            "Invalid CLI OAuth application",
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === 404) {
            throw new ApiError(
              404,
              "This server does not provide the built-in Cloudreve CLI OAuth application",
              undefined,
              undefined,
              undefined,
              { kind: "unsupported", cause: error },
            );
          }

          throw error;
        }
      },
      normalized,
      this.signal,
    );
  }

  async exchangeOAuthToken(
    options: {
      code: string;
      codeVerifier: string;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
    operationOptions?: CallOptions,
  ): Promise<OAuthTokenResponse> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const data = record(
          await this.call(
            "session/oauth/token",
            {
              ...nestedOptions,
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: string(options.clientId),
                client_secret: string(options.clientSecret),
                code: string(options.code),
                code_verifier: string(options.codeVerifier),
                redirect_uri: string(options.redirectUri),
              }).toString(),
            },
            true,
          ),
        );

        return decode(OAuthTokenSchema, data, "Invalid OAuth expiration or scope");
      },
      normalized,
      this.signal,
    );
  }

  async oauthUserInfo(
    accessToken: string,
    operationOptions?: CallOptions,
  ): Promise<OAuthUserInfoResponse> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const data = record(
          await this.call(
            "session/oauth/userinfo",
            {
              ...nestedOptions,
              headers: { Authorization: `Bearer ${string(accessToken)}` },
            },
            true,
          ),
        );

        string(data.sub);

        return data as unknown as OAuthUserInfoResponse;
      },
      normalized,
      this.signal,
    );
  }

  async config(operationOptions?: CallOptions): Promise<LoginConfig> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const [basic, login] = await Promise.all([
          this.call("site/config/basic", nestedOptions),
          this.call("site/config/login", nestedOptions),
        ]);

        const value = { ...record(basic), ...record(login) };
        const result: LoginConfig = {};

        for (const key of [
          "login_captcha",
          "reg_captcha",
          "forget_captcha",
          "register_enabled",
        ] as const) {
          if (value[key] !== undefined) {
            if (typeof value[key] !== "boolean") {
              throw new ApiError(-1, "Invalid login settings");
            }

            result[key] = value[key];
          }
        }

        for (const key of [
          "captcha_type",
          "captcha_ReCaptchaKey",
          "turnstile_site_id",
          "captcha_cap_instance_url",
          "captcha_cap_site_key",
          "captcha_cap_asset_server",
        ] as const) {
          if (value[key] !== undefined) {
            if (typeof value[key] !== "string" || value[key].length > 2048) {
              throw new ApiError(-1, "Invalid login settings");
            }

            result[key] = value[key];
          }
        }

        return result;
      },
      normalized,
      this.signal,
    );
  }

  async prepare(
    email: string,
    operationOptions?: CallOptions,
  ): Promise<{
    passwordEnabled: boolean;
    webAuthnEnabled: boolean;
    ssoEnabled: boolean;
  }> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const data = record(
          await this.call(
            "session/prepare?email=" + encodeURIComponent(email.trim()),
            nestedOptions,
          ),
        );

        return {
          passwordEnabled: data.password_enabled !== false,
          webAuthnEnabled: data.webauthn_enabled === true,
          ssoEnabled: data.sso_enabled === true || data.oidc_enabled === true,
        };
      },
      normalized,
      this.signal,
    );
  }

  async captcha(operationOptions?: CallOptions): Promise<{ image: string; ticket: string }> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const data = record(await this.call("site/captcha", nestedOptions));
        const image = string(data.image);

        if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(image)) {
          throw new ApiError(-1, "Invalid captcha image");
        }

        return { image, ticket: string(data.ticket) };
      },
      normalized,
      this.signal,
    );
  }

  async password(
    email: string,
    password: string,
    captcha: CaptchaAnswer = {},
    operationOptions?: CallOptions,
  ): Promise<LoginResult> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        if (!email.trim() || password.length < 4 || password.length > 128) {
          throw new ApiError(-1, "Enter your email and password");
        }

        try {
          return {
            kind: "authenticated",
            session: session(
              await this.call("session/token", {
                ...nestedOptions,
                method: "POST",
                body: JSON.stringify({
                  email: email.trim(),
                  password,
                  ...captcha,
                }),
              }),
            ),
          };
        } catch (error) {
          if (error instanceof ApiError && error.code === 203) {
            return { kind: "otp", sessionId: string(error.data) };
          }

          throw error;
        }
      },
      normalized,
      this.signal,
    );
  }

  async otp(
    sessionId: string,
    otp: string,
    operationOptions?: CallOptions,
  ): Promise<PasswordLoginResponse> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        if (!sessionId || !/^\d{6}$/.test(otp)) {
          throw new ApiError(-1, "Enter the six-digit verification code");
        }

        return session(
          await this.call("session/token/2fa", {
            ...nestedOptions,
            method: "POST",
            body: JSON.stringify({ session_id: sessionId, otp }),
          }),
        );
      },
      normalized,
      this.signal,
    );
  }

  async resetPassword(
    email: string,
    captcha: CaptchaAnswer = {},
    operationOptions?: CallOptions,
  ): Promise<void> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        if (!email.trim()) {
          throw new ApiError(-1, "Enter your account email");
        }

        await this.call("user/reset", {
          ...nestedOptions,
          method: "POST",
          body: JSON.stringify({ email: email.trim(), ...captcha }),
        });
      },
      normalized,
      this.signal,
    );
  }

  async importRefreshToken(
    refreshToken: string,
    operationOptions?: CallOptions,
  ): Promise<PasswordLoginResponse> {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        if (!refreshToken || refreshToken.length > 16384) {
          throw new ApiError(-1, "Invalid refresh token");
        }

        const token = tokens(
          await this.call("session/token/refresh", {
            ...nestedOptions,
            method: "POST",
            body: JSON.stringify({ refresh_token: refreshToken }),
          }),
        );

        const config = record(
          await this.call("site/config/basic", {
            ...nestedOptions,
            headers: { Authorization: `Bearer ${token.access_token}` },
          }),
        );

        return { token, user: user(config.user) };
      },
      normalized,
      this.signal,
    );
  }
}

/** @public */
export function parseCredentialLink(input: string): {
  endpoint: string;
  refreshToken: string;
} {
  const url = new URL(input.trim());

  if (/^\/api\/v4\/user\/session\/copy\/[^/]+$/.test(url.pathname)) {
    throw new ApiError(
      -1,
      "Signed session-copy links are unsupported by this Community backend",
      undefined,
      undefined,
      undefined,
      { kind: "unsupported" },
    );
  }

  const values = url.searchParams.getAll("refresh_token");

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    values.length !== 1 ||
    !values[0] ||
    values[0].length > 16384 ||
    values[0] !== values[0].trim()
  ) {
    throw new ApiError(-1, "Invalid sign-in QR link");
  }

  return { endpoint: url.origin, refreshToken: values[0] };
}
