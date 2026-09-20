import { ApiError } from "../protocol/index.ts";

/** Built-in public CLI registration. The distributed client secret is not confidential. @public */
export const CLI_OAUTH_CLIENT = Object.freeze({
  clientId: "6326d2af-2fef-4a99-94da-1ee8ef0ca53f",
  clientSecret: "yoFiNgbxvSCzK2Nm92T3TNaREh4qBjq4",
  redirectUri: "http://127.0.0.1/callback",
  scope:
    "profile email openid offline_access UserInfo.Write Workflow.Write Files.Write Shares.Write",
} as const);

function serverOrigin(endpoint: string): string {
  const url = new URL(endpoint);

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(-1, "Invalid OAuth server URL");
  }

  return url.origin;
}

function validateState(state: string): void {
  if (!state || state.length > 4096 || /[^!-~]/.test(state)) {
    throw new ApiError(-1, "Invalid OAuth state");
  }
}

/** Build consent for a bound IPv4 loopback listener with caller-generated state and S256 PKCE. @public */
export function createCliOAuthAuthorizationUrl(
  endpoint: string,
  options: { state: string; challenge: string; redirectUri: string },
): string {
  validateState(options.state);

  if (options.challenge.length !== 43 || /[^A-Za-z0-9_-]/.test(options.challenge)) {
    throw new ApiError(-1, "Invalid S256 PKCE challenge");
  }

  const redirect = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/.exec(options.redirectUri);

  if (!redirect || redirect[0] !== options.redirectUri || Number(redirect[1]) > 65535) {
    throw new ApiError(-1, "CLI OAuth requires an HTTP loopback callback with a bound port");
  }

  const url = new URL("/session/authorize", serverOrigin(endpoint));

  url.search = new URLSearchParams({
    client_id: CLI_OAUTH_CLIENT.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: CLI_OAUTH_CLIENT.scope,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
  }).toString();

  return url.href;
}
