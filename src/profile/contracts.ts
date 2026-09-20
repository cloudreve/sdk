import * as v from "valibot";
import { natural, nonempty } from "../protocol/index.ts";
import { PasskeySchema } from "../session/index.ts";

/** @public */
export const GrantSchema = v.looseObject({
  client_id: nonempty,
  client_name: v.string(),
  client_logo: v.string(),
  scopes: v.nullish(v.array(v.string()), []),
  last_used_at: v.nullable(v.string()),
});

/** @public */
export type OAuthGrant = v.InferOutput<typeof GrantSchema>;

/** @public */
export const SettingsSchema = v.looseObject({
  passwordless: v.boolean(),
  two_fa_enabled: v.boolean(),
  disable_view_sync: v.boolean(),
  version_retention_enabled: v.optional(v.boolean(), false),
  version_retention_ext: v.nullish(v.array(v.string()), []),
  version_retention_max: v.optional(natural, 0),
  share_links_in_profile: v.optional(v.string(), ""),
  passkeys: v.nullish(v.array(PasskeySchema), []),
  oauth_grants: v.nullish(v.array(GrantSchema), []),
});

/** @public */
export type UserSettings = v.InferOutput<typeof SettingsSchema>;

/** @public */
export const SettingsPatchSchema = v.strictObject({
  nick: v.optional(nonempty),
  language: v.optional(nonempty),
  preferred_theme: v.optional(nonempty),
  version_retention_enabled: v.optional(v.boolean()),
  version_retention_ext: v.optional(v.array(v.string())),
  version_retention_max: v.optional(natural),
  disable_view_sync: v.optional(v.boolean()),
  share_links_in_profile: v.optional(v.string()),
});

/** Non-security preferences; use password/setTwoFactor for security changes. @public */
export type SettingsPatch = v.InferInput<typeof SettingsPatchSchema>;

/** @public */
export const UserProfileSchema = v.looseObject({
  id: nonempty,
  nickname: v.string(),
  email: v.optional(v.string()),
  avatar: v.optional(v.string()),
  language: v.optional(v.string()),
  preferred_theme: v.optional(v.string()),
  pined: v.optional(v.array(v.object({ uri: nonempty, name: v.optional(v.string()) }))),
});
