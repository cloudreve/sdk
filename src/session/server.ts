import parse from "semver/functions/parse.js";
import { record, type Transport } from "../protocol/index.ts";

/** Earliest generic OAuth release; discover built-in applications separately. @public */
export const MIN_OAUTH_VERSION = "4.12.0";

/** @public */
export type ValidationErrorType = "httpError" | "apiError" | "versionTooLow" | "connectionFailed";

/** @public */
export interface ValidationError {
  type: ValidationErrorType;
  params: Record<string, string>;
}

/** @public */
export interface SiteVersionResult {
  version: string;
  isPro: boolean;
}

/** @public */
export class SiteValidationError extends Error implements ValidationError {
  constructor(
    public type: ValidationErrorType,
    public params: Record<string, string>,
  ) {
    super(params.message ?? type);
  }
}

/** @public */
export function isValidationError(error: unknown): error is ValidationError {
  return !!error && typeof error === "object" && "type" in error && "params" in error;
}

/** @public */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Invalid server URL");
  }

  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function canonicalVersion(version: string) {
  const parsed = parse(version);

  if (
    !parsed ||
    version !== parsed.version + (parsed.build.length ? "+" + parsed.build.join(".") : "")
  ) {
    throw new Error("Invalid version");
  }

  return parsed;
}

/** @public */
export function compareSemver(a: string, b: string): number {
  const left = canonicalVersion(a);
  const right = canonicalVersion(b);

  if (left.compareMain(right) === 0) {
    const index = left.prerelease.findIndex((id, i) => String(id) !== String(right.prerelease[i]));

    const x = String(left.prerelease[index]);
    const y = String(right.prerelease[index]);

    // node-semver coerces numeric prerelease identifiers to Number during comparison.
    // Preserve SemVer precedence beyond Number.MAX_SAFE_INTEGER without replacing its parser.
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      return BigInt(x) < BigInt(y) ? -1 : 1;
    }
  }

  return left.compare(right);
}

/** @public */
export async function validateServerVersion(
  siteUrl: string,
  transport: Transport,
): Promise<SiteVersionResult> {
  let response;

  try {
    response = await transport(new URL("/api/v4/site/ping", siteUrl).toString(), {
      redirect: "error",
    });
  } catch (error) {
    throw new SiteValidationError("connectionFailed", {
      message: error instanceof Error ? error.message : "Connection failed",
    });
  }

  if (!response.ok) {
    throw new SiteValidationError("httpError", {
      status: String(response.status),
    });
  }

  const data = record(await response.json());

  if (data.code !== 0) {
    throw new SiteValidationError("apiError", {
      message: typeof data.msg === "string" && data.msg ? data.msg : "Unknown error",
    });
  }

  const isPro = typeof data.data === "string" && data.data.endsWith("-pro");
  const version = typeof data.data === "string" ? data.data.replace(/-pro$/, "") : "";

  try {
    canonicalVersion(version);
  } catch {
    throw new SiteValidationError("apiError", {
      message: "Invalid server version",
    });
  }

  if (compareSemver(version, "4.0.0") < 0) {
    throw new SiteValidationError("versionTooLow", {
      version,
      minVersion: "4.0.0",
    });
  }

  return { version, isPro };
}
