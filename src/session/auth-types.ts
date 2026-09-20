/**
 * OAuth token response (RAW -- NOT wrapped in standard envelope).
 * POST /api/v4/session/oauth/token
 */
/** @public */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in: number;
  scope: string;
}

/**
 * OAuth userinfo response (RAW OIDC -- NOT wrapped in standard envelope).
 * GET /api/v4/session/oauth/userinfo
 */
/** @public */
export interface OAuthUserInfoResponse {
  sub: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  updated_at?: number;
  email?: string;
  email_verified?: boolean;
}

/**
 * Token from password login (ISO timestamp strings, NOT seconds).
 * POST /api/v4/session/token
 */
/** @public */
export interface PasswordLoginToken {
  access_token: string;
  refresh_token: string;
  access_expires: string; // ISO 8601 timestamp
  refresh_expires: string; // ISO 8601 timestamp
}

/** POST /api/v4/session/token response data (standard envelope). */
/** @public */
export interface PasswordLoginResponse {
  user: SiteConfigUser;
  token: PasswordLoginToken;
}

/** Minimal user info from site config */
/** @public */
export interface SiteConfigUser {
  id: string;
  nickname: string;
  email?: string;
  avatar?: string;
  group?: { id: string | number; name: string; permission?: string };
}

/** GET /api/v4/site/config response data (partial) */
/** @public */
export interface SiteConfig {
  siteName?: string;
  user?: SiteConfigUser;
}
