import * as v from "valibot";
import { decode, nonempty, finite, natural } from "../protocol/index.ts";
import type { PasswordLoginToken, OAuthTokenResponse } from "./auth-types.ts";

/** @public */
export const TokensSchema = v.object({
  accessToken: nonempty,
  refreshToken: nonempty,
  accessExpiresAt: finite,
  refreshExpiresAt: finite,
});

/** @public */
export type Tokens = v.InferOutput<typeof TokensSchema>;

/** @public */
export const SessionRecordSchema = v.object({
  generation: nonempty,
  tokens: v.nullable(TokensSchema),
});

/** @public */
export type SessionRecord = v.InferOutput<typeof SessionRecordSchema>;

/** @public */
export const PasswordTokenSchema = v.object({
  access_token: nonempty,
  refresh_token: nonempty,
  access_expires: v.pipe(
    nonempty,
    v.check((value) => Number.isFinite(Date.parse(value))),
  ),
  refresh_expires: v.pipe(
    nonempty,
    v.check((value) => Number.isFinite(Date.parse(value))),
  ),
});

/** @public */
export const OAuthTokenSchema = v.looseObject({
  access_token: nonempty,
  refresh_token: nonempty,
  token_type: nonempty,
  expires_in: natural,
  refresh_token_expires_in: natural,
  scope: v.string(),
});

/** @public */
export function tokensFromPassword(value: PasswordLoginToken): Tokens {
  const token = decode(PasswordTokenSchema, value, "Invalid token response");

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: Date.parse(token.access_expires),
    refreshExpiresAt: Date.parse(token.refresh_expires),
  };
}

/** @public */
export function tokensFromOAuth(value: OAuthTokenResponse, nowMs = Date.now()): Tokens {
  const token = decode(OAuthTokenSchema, value, "Invalid OAuth token response");

  return decode(TokensSchema, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: nowMs + token.expires_in * 1000,
    refreshExpiresAt: nowMs + token.refresh_token_expires_in * 1000,
  });
}
