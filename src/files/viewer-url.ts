import { ApiError } from "../protocol/index.ts";

/** @public */
export interface ViewerVariables {
  src: string;
  name: string;
  id: string;
  version?: string;
  userId?: string;
  userDisplayName?: string;
  theme: "light" | "dark";
}

/** Expand configured viewer variables; external application schemes require an explicit allowlist. @public */
export function customViewerUrl(
  template: string,
  input: ViewerVariables,
  allowedExternalSchemes: readonly string[] = [],
): string {
  const source = new URL(input.src);

  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw new ApiError(-1, "Invalid viewer source URL");
  }

  const vars: Record<string, string> = {
    src: encodeURIComponent(input.src),
    src_raw: input.src,
    src_raw_base64: btoa(
      Array.from(new TextEncoder().encode(input.src), (byte) => String.fromCharCode(byte)).join(""),
    ),
    name: encodeURIComponent(input.name),
    id: input.id,
    version: input.version ?? "",
    user_id: input.userId ?? "",
    user_display_name: encodeURIComponent(input.userDisplayName ?? ""),
    theme: input.theme,
    dark: input.theme === "dark" ? "1" : "0",
  };

  const value = template.replace(
    /\{\$(src|src_raw|src_raw_base64|name|id|version|user_id|user_display_name|theme|dark)\}/g,
    (_match, key: string) => vars[key]!,
  );

  const url = new URL(value);
  const scheme = url.protocol.slice(0, -1).toLowerCase();

  if (
    url.username ||
    url.password ||
    ["javascript", "data", "file", "content", "intent", "blob", "about"].includes(scheme) ||
    (!["http", "https"].includes(scheme) && !allowedExternalSchemes.includes(scheme))
  ) {
    throw new ApiError(-1, "Unsupported viewer URL scheme or credentials");
  }

  return url.toString();
}
