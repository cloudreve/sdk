import * as v from "valibot";
import { decode, nonempty } from "../protocol/index.ts";
import {
  CredentialOptionsSchema,
  CredentialResponseSchema,
  PasskeySchema,
  OAuthApplicationSchema,
  OAuthConsentSchema,
  OAuthConsentResponseSchema,
  type CredentialOptions,
  type Passkey,
  type OAuthApplication,
  type OAuthConsent,
} from "../session/index.ts";
import {
  SettingsSchema,
  UserProfileSchema,
  SettingsPatchSchema,
  type UserSettings,
  type SettingsPatch,
} from "./contracts.ts";

export type { UserSettings, SettingsPatch, OAuthGrant } from "./contracts.ts";

import { withDeadline, toRequestOptions, type CallOptions } from "../protocol/index.ts";
import type { RequestScope } from "../protocol/index.ts";
import type { UploadSource } from "../transfers/index.ts";
import { ApiError, record } from "../protocol/index.ts";

/** @public */
export interface UserProfile {
  id: string;
  nickname: string;
  email?: string;
  avatar?: string;
  language?: string;
  preferred_theme?: string;
  pined?: { uri: string; name?: string }[];
}

/** @public */
export class Profile {
  constructor(private client: RequestScope) {}

  async userInfo(userId: string, options?: CallOptions): Promise<UserProfile> {
    const value = record(
      await this.client.request(
        "/api/v4/user/info/" + encodeURIComponent(userId),
        toRequestOptions(options),
      ),
    );

    if (typeof value.id !== "string" || typeof value.nickname !== "string") {
      throw new ApiError(-1, "Invalid profile response");
    }

    return value as unknown as UserProfile;
  }

  async capacity(): Promise<{
    total: number;
    used: number;
    storage_pack_total: number;
  }> {
    const value: Record<string, unknown> = {
      storage_pack_total: 0,
      ...record(await this.client.request("/api/v4/user/capacity")),
    };

    for (const key of ["total", "used", "storage_pack_total"]) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
        throw new ApiError(-1, "Invalid capacity response");
      }
    }

    return value as { total: number; used: number; storage_pack_total: number };
  }

  async me(optionsOrSignal?: CallOptions): Promise<UserProfile> {
    const value = record(
      await this.client.request("/api/v4/user/me", toRequestOptions(optionsOrSignal)),
    );

    return decode(UserProfileSchema, value, "Invalid profile response");
  }

  async pins(options?: CallOptions): Promise<{ uri: string; name?: string }[]> {
    return (await this.me(options)).pined ?? [];
  }

  async settings(optionsOrSignal?: CallOptions): Promise<UserSettings> {
    return decode(
      SettingsSchema,
      await this.client.request("/api/v4/user/setting", toRequestOptions(optionsOrSignal)),
      "Invalid settings response",
    );
  }

  async patchSettings(input: SettingsPatch, options?: CallOptions): Promise<void> {
    await this.patch(
      decode(
        v.pipe(
          SettingsPatchSchema,
          v.check((value) => Object.values(value).some((item) => item !== undefined)),
        ),
        input,
        "Invalid account preferences",
      ),
      options,
    );
  }

  async initTwoFactor(options?: CallOptions): Promise<string> {
    return decode(
      nonempty,
      await this.client.request("/api/v4/user/setting/2fa", {
        ...toRequestOptions(options),
        retry: "never",
      }),
      "Invalid two-factor secret",
    );
  }

  async setTwoFactor(enabled: boolean, code: string, options?: CallOptions): Promise<void> {
    await this.patch(
      {
        two_fa_enabled: decode(v.boolean(), enabled, "Invalid two-factor state"),
        two_fa_code: decode(nonempty, code, "Enter the two-factor code"),
      },
      options,
    );
  }

  async beginPasskeyRegistration(options?: CallOptions): Promise<CredentialOptions> {
    return decode(
      CredentialOptionsSchema,
      await this.mutate("user/authn", "PUT", undefined, options),
      "Invalid registration options",
    );
  }

  async finishPasskeyRegistration(
    input: { name: string; ua: string; response: Record<string, unknown> },
    options?: CallOptions,
  ): Promise<Passkey> {
    const body = {
      name: decode(nonempty, input.name, "Enter a passkey name"),
      ua: decode(nonempty, input.ua, "User agent required"),
      response: JSON.stringify(
        decode(CredentialResponseSchema, input.response, "Invalid passkey response"),
      ),
    };

    return decode(
      PasskeySchema,
      await this.mutate("user/authn", "POST", body, options),
      "Invalid passkey",
    );
  }

  async deletePasskey(id: string, options?: CallOptions): Promise<void> {
    await this.mutate(
      `user/authn?id=${encodeURIComponent(decode(nonempty, id, "Invalid passkey ID"))}`,
      "DELETE",
      undefined,
      options,
    );
  }

  async revokeGrant(clientId: string, options?: CallOptions): Promise<void> {
    await this.mutate(
      `session/oauth/grant/${encodeURIComponent(decode(nonempty, clientId, "Invalid client ID"))}`,
      "DELETE",
      undefined,
      options,
    );
  }

  async oauthApplication(clientId: string, options?: CallOptions): Promise<OAuthApplication> {
    return decode(
      OAuthApplicationSchema,
      await this.client.request(
        `/api/v4/session/oauth/app/${encodeURIComponent(decode(nonempty, clientId, "Invalid client ID"))}`,
        toRequestOptions(options),
      ),
      "Invalid OAuth application",
    );
  }

  async consentOAuth(
    input: OAuthConsent,
    options?: CallOptions,
  ): Promise<{ code: string; state: string }> {
    return decode(
      OAuthConsentResponseSchema,
      await this.mutate(
        "session/oauth/consent",
        "POST",
        decode(OAuthConsentSchema, input, "Invalid OAuth consent"),
        options,
      ),
      "Invalid OAuth consent result",
    );
  }

  async searchUsers(keyword: string, options?: CallOptions): Promise<UserProfile[]> {
    const data = await this.client.request<unknown>(
      `/api/v4/user/search?keyword=${encodeURIComponent(decode(v.pipe(nonempty, v.minLength(2)), keyword, "Enter at least two characters"))}`,
      toRequestOptions(options),
    );

    return decode(
      v.array(v.looseObject({ id: nonempty, nickname: v.string() })),
      data,
      "Invalid user search results",
    );
  }

  private mutate(
    path: string,
    method: string,
    body: unknown,
    options?: CallOptions,
  ): Promise<unknown> {
    return this.client.request(`/api/v4/${path}`, {
      ...toRequestOptions(options),
      retry: "never",
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async rename(nickname: string, operationOptions?: CallOptions) {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        const nick = nickname.trim();

        if (!nick || [...nick].length > 255) {
          throw new ApiError(-1, "Enter a name of 1–255 characters");
        }

        await this.patch({ nick }, nestedOptions);

        return this.me(nestedOptions);
      },
      normalized,
      this.client.signal,
    );
  }

  async password(current: string, next: string, operationOptions?: CallOptions) {
    if (
      [...current].length < 4 ||
      [...current].length > 128 ||
      [...next].length < 6 ||
      [...next].length > 128
    ) {
      throw new ApiError(-1, "Enter your current password and a new password of 6–128 characters");
    }

    await this.patch({ current_password: current, new_password: next }, operationOptions);
  }

  async avatar(
    source: UploadSource | null,
    mimeType = "image/png",
    operationOptions?: CallOptions,
  ) {
    const normalized = toRequestOptions(operationOptions);

    return withDeadline(
      async (signal) => {
        const nestedOptions = { ...normalized, signal, timeoutMs: 0 };

        if (
          source &&
          (!Number.isSafeInteger(source.size) ||
            source.size <= 0 ||
            source.size > 5 * 1024 * 1024 ||
            !["image/png", "image/jpeg", "image/gif"].includes(mimeType))
        ) {
          throw new ApiError(-1, "Choose a PNG, JPEG or GIF image up to 5 MB");
        }

        const chunk = source
          ? await source.chunk(0, source.size, undefined, () => {}, signal)
          : null;

        try {
          await this.client.request("/api/v4/user/setting/avatar", {
            ...toRequestOptions(nestedOptions),
            retry: "never",
            method: "PUT",
            headers: { "Content-Type": mimeType },
            body: chunk?.body ?? "",
          });

          return await this.me(nestedOptions);
        } finally {
          await chunk?.dispose();
        }
      },
      normalized,
      this.client.signal,
    );
  }

  private async patch(value: Record<string, unknown>, operationOptions?: CallOptions) {
    await this.client.request("/api/v4/user/setting", {
      ...toRequestOptions(operationOptions),
      retry: "never",
      method: "PATCH",
      body: JSON.stringify(value),
    });
  }
}

/** @public */
export function avatarUrl(endpoint: string, userId: string): string {
  const url = new URL(endpoint);

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(-1, "Invalid server URL");
  }

  return new URL("/api/v4/user/avatar/" + encodeURIComponent(userId), url).toString();
}

export * from "./contracts.ts";
