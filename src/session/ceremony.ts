import * as v from "valibot";
import { nonempty, decode, ApiError } from "../protocol/index.ts";

/** @public */
export const CredentialOptionsSchema = v.looseObject({
  publicKey: v.looseObject({ challenge: nonempty }),
});

/** JSON WebAuthn options; platform adapters perform the authenticator ceremony. @public */
export type CredentialOptions = v.InferOutput<typeof CredentialOptionsSchema>;

/** @public */
export const CredentialResponseSchema = v.looseObject({
  id: nonempty,
  rawId: nonempty,
  type: v.literal("public-key"),
  response: v.looseObject({ clientDataJSON: nonempty }),
});

/** @public */
export const PasskeySchema = v.looseObject({
  id: nonempty,
  name: v.string(),
  created_at: v.string(),
  used_at: v.optional(v.string()),
});

/** @public */
export type Passkey = v.InferOutput<typeof PasskeySchema>;

/** @public */
export const OAuthApplicationSchema = v.looseObject({
  id: nonempty,
  name: v.string(),
  homepage_url: v.optional(v.string()),
  icon: v.optional(v.string()),
  description: v.optional(v.string()),
  consented_scopes: v.nullish(v.array(v.string()), []),
});

/** @public */
export type OAuthApplication = v.InferOutput<typeof OAuthApplicationSchema>;

/** @public */
export const OAuthConsentSchema = v.object({
  client_id: nonempty,
  response_type: v.literal("code"),
  redirect_uri: v.pipe(nonempty, v.url()),
  scope: nonempty,
  state: v.optional(v.string()),
  code_challenge: v.optional(v.string()),
  code_challenge_method: v.optional(v.literal("S256")),
});

/** @public */
export type OAuthConsent = v.InferInput<typeof OAuthConsentSchema>;

/** @public */
export const OAuthConsentResponseSchema = v.object({
  code: nonempty,
  state: v.string(),
});

/** Parse authorization request data without approving consent or opening a redirect. @public */
export function parseOAuthAuthorizationLink(input: string, endpoint: string): OAuthConsent {
  const url = new URL(input);
  const server = new URL(endpoint);

  if (
    url.origin !== server.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/session/authorize"
  ) {
    throw new ApiError(-1, "Invalid OAuth authorization link");
  }

  const values: Record<string, string> = {};

  for (const key of [
    "client_id",
    "response_type",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]) {
    const parts = url.searchParams.getAll(key);

    if (parts.length > 1) {
      throw new ApiError(-1, "Duplicate OAuth parameter");
    }

    if (parts.length) {
      values[key] = parts[0]!;
    }
  }

  const consent = decode(OAuthConsentSchema, values, "Invalid OAuth authorization request");
  const redirect = new URL(consent.redirect_uri);

  if (
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    ["javascript:", "data:", "file:", "content:", "intent:", "blob:", "about:"].includes(
      redirect.protocol,
    )
  ) {
    throw new ApiError(-1, "Unsafe OAuth redirect URI");
  }

  if (
    (consent.code_challenge_method && !consent.code_challenge) ||
    (consent.code_challenge && !/^[A-Za-z0-9_-]{43}$/.test(consent.code_challenge))
  ) {
    throw new ApiError(-1, "Invalid PKCE challenge");
  }

  return consent;
}
