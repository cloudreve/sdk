import { ApiError } from "../protocol/index.ts";

const CR_PREFIX = "cloudreve://";
const HTTP_PREFIX = "http://";

/** @public */
export interface SearchParams {
  name?: string[];
  nameOpOr?: boolean;
  useOr?: boolean;
  metadata?: { key: string; value: string; exact?: boolean }[];
  caseFolding?: boolean;
  type?: "file" | "folder";
  category?: string;
  sizeGte?: number;
  sizeLte?: number;
  createdGte?: number;
  createdLte?: number;
  updatedGte?: number;
  updatedLte?: number;
}

/** Query param keys the backend recognizes for search (uri.go). */
const SEARCH_PARAM_KEYS = [
  "name",
  "name_op_or",
  "use_or",
  "case_folding",
  "type",
  "size_gte",
  "size_lte",
  "created_gte",
  "created_lte",
  "updated_gte",
  "updated_lte",
] as const;

/** @public */
export const UriSearchCategory = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "document",
} as const;

/** @public */
export type UriSearchCategoryValue = (typeof UriSearchCategory)[keyof typeof UriSearchCategory];

/** @public */
export class CrUri {
  private url: URL;

  constructor(u: string) {
    if (!u.startsWith(CR_PREFIX)) {
      throw new Error("Invalid cloudreve URI");
    }

    this.url = new URL(u.replace(CR_PREFIX, HTTP_PREFIX));

    // Normalize: strip trailing slash from pathname
    if (this.url.pathname.length > 1) {
      this.url.pathname = this.url.pathname.replace(/\/$/, "");
    }
  }

  /** Filesystem identifier: "my", "shared_with_me", "trash", "share" */
  fs(): string {
    return this.url.hostname;
  }

  /** Embedded identifier (URL username), e.g. the share ID in cloudreve://shareId@share/ */
  id(): string {
    return decodeURIComponent(this.url.username);
  }

  /** Embedded password (URL password), e.g. the share password in cloudreve://id:pass@share/ */
  password(): string {
    return decodeURIComponent(this.url.password);
  }

  /** Return an ephemeral share URI with an encoded password; never persist it in navigation history. */
  withPassword(password: string): CrUri {
    if (this.fs() !== "share" || typeof password !== "string") {
      throw new Error("Passwords are supported only for share URIs");
    }

    const result = new CrUri(this.toString());

    result.url.password = password;

    return result;
  }

  /** Full decoded path, e.g. "/Documents/Photos" */
  path(): string {
    return decodeURIComponent(this.url.pathname);
  }

  /** Path segments, e.g. ["Documents", "Photos"] */
  elements(): string[] {
    const trimmed = this.url.pathname.slice(1); // remove leading /

    if (trimmed === "") {
      return [];
    }

    return trimmed.split("/").map((p) => decodeURIComponent(p));
  }

  /** True when at filesystem root (no path or just "/") */
  isRoot(): boolean {
    return this.url.pathname === "" || this.url.pathname === "/";
  }

  /** Return the "category" query param value, or null if absent. */
  category(): string | null {
    return this.url.searchParams.get("category");
  }

  /** Return a new CrUri with the category query param set (or cleared if null). */
  withCategory(category: string | null): CrUri {
    const result = new CrUri(this.toString());

    if (category) {
      result.url.searchParams.set("category", category);
    } else {
      result.url.searchParams.delete("category");
    }

    return result;
  }

  /** Return a new CrUri with additional path segments appended */
  join(...paths: string[]): CrUri {
    const result = new CrUri(this.toString());

    const joined = (
      result.url.pathname +
      "/" +
      paths.map((p) => encodeURIComponent(p)).join("/")
    ).replace(/\/+/g, "/");

    result.url.pathname = joined;

    return result;
  }

  /** Return a new CrUri pointing to the parent directory */
  parent(): CrUri {
    const result = new CrUri(this.toString());
    const parts = result.elements();

    parts.pop();

    result.url.pathname =
      parts.length > 0 ? "/" + parts.map((p) => encodeURIComponent(p)).join("/") : "/";

    return result;
  }

  /** Serialize back to cloudreve:// form */
  toString(): string {
    const str = this.url.toString().replace(HTTP_PREFIX, CR_PREFIX);

    // Remove trailing slash unless it's the root path
    if (str.endsWith("/") && str !== CR_PREFIX + this.url.hostname + "/") {
      return str.slice(0, -1);
    }

    return str;
  }

  /** True if this URI has search query params (beyond just category). */
  isSearch(): boolean {
    return (
      SEARCH_PARAM_KEYS.some((key) => this.url.searchParams.has(key)) ||
      [...this.url.searchParams.keys()].some(
        (key) => key.startsWith("meta_") || key.startsWith("exact_meta_"),
      )
    );
  }

  /** Return a new CrUri with search params applied. Clears existing search params first. */
  withSearchParams(params: SearchParams): CrUri {
    const result = new CrUri(this.toString());

    result.url.searchParams.delete("category");

    // Clear existing search params
    for (const key of SEARCH_PARAM_KEYS) {
      result.url.searchParams.delete(key);
    }

    for (const key of [...result.url.searchParams.keys()]) {
      if (key.startsWith("meta_") || key.startsWith("exact_meta_")) {
        result.url.searchParams.delete(key);
      }
    }

    if (params.nameOpOr) {
      result.url.searchParams.set("name_op_or", "");
    }

    if (params.useOr) {
      result.url.searchParams.set("use_or", "");
    }

    for (const item of params.metadata ?? []) {
      result.url.searchParams.set(`${item.exact ? "exact_meta_" : "meta_"}${item.key}`, item.value);
    }

    if (params.name) {
      for (const n of params.name) {
        result.url.searchParams.append("name", n);
      }
    }

    if (params.caseFolding) {
      result.url.searchParams.set("case_folding", "");
    }

    if (params.type) {
      result.url.searchParams.set("type", params.type);
    }

    if (params.category) {
      result.url.searchParams.set("category", params.category);
    }

    if (params.sizeGte != null) {
      result.url.searchParams.set("size_gte", String(params.sizeGte));
    }

    if (params.sizeLte != null) {
      result.url.searchParams.set("size_lte", String(params.sizeLte));
    }

    if (params.createdGte != null) {
      result.url.searchParams.set("created_gte", String(params.createdGte));
    }

    if (params.createdLte != null) {
      result.url.searchParams.set("created_lte", String(params.createdLte));
    }

    if (params.updatedGte != null) {
      result.url.searchParams.set("updated_gte", String(params.updatedGte));
    }

    if (params.updatedLte != null) {
      result.url.searchParams.set("updated_lte", String(params.updatedLte));
    }

    result.assertValidSearch();

    return result;
  }

  /** Backend category presets replace the whole query and cannot be intersected with filters. */
  assertValidSearch(): void {
    if (this.category() && this.isSearch()) {
      throw new ApiError(-1, "Category presets cannot be combined with search filters");
    }
  }

  /** Parse search params from this URI. Returns undefined if not a search URI. */
  searchParams(): SearchParams | undefined {
    if (!this.isSearch()) {
      return undefined;
    }

    const sp = this.url.searchParams;
    const params: SearchParams = {};

    if (sp.has("name_op_or")) {
      params.nameOpOr = true;
    }

    if (sp.has("use_or")) {
      params.useOr = true;
    }

    for (const [key, value] of sp) {
      if (key.startsWith("meta_") || key.startsWith("exact_meta_")) {
        const exact = key.startsWith("exact_meta_");

        (params.metadata ??= []).push({
          key: key.slice(exact ? 11 : 5),
          value,
          exact,
        });
      }
    }

    const names = sp.getAll("name").filter(Boolean);

    if (names.length > 0) {
      params.name = names;
    }

    if (sp.has("case_folding")) {
      params.caseFolding = true;
    }

    const typeVal = sp.get("type");

    if (typeVal === "file" || typeVal === "0") {
      params.type = "file";
    }

    if (typeVal === "folder" || typeVal === "1") {
      params.type = "folder";
    }

    const cat = sp.get("category");

    if (cat) {
      params.category = cat;
    }

    const sizeGte = sp.get("size_gte");

    if (sizeGte) {
      params.sizeGte = Number(sizeGte);
    }

    const sizeLte = sp.get("size_lte");

    if (sizeLte) {
      params.sizeLte = Number(sizeLte);
    }

    const createdGte = sp.get("created_gte");

    if (createdGte) {
      params.createdGte = Number(createdGte);
    }

    const createdLte = sp.get("created_lte");

    if (createdLte) {
      params.createdLte = Number(createdLte);
    }

    const updatedGte = sp.get("updated_gte");

    if (updatedGte) {
      params.updatedGte = Number(updatedGte);
    }

    const updatedLte = sp.get("updated_lte");

    if (updatedLte) {
      params.updatedLte = Number(updatedLte);
    }

    return params;
  }

  // --- Static factory instances ---

  static share(id: string, password?: string): CrUri {
    if (typeof id !== "string" || !id) {
      throw new Error("Share ID is required");
    }

    const result = new CrUri("cloudreve://share/");

    result.url.username = id;

    return password === undefined ? result : result.withPassword(password);
  }

  static readonly my = new CrUri("cloudreve://my");
  static readonly myImages = new CrUri("cloudreve://my/?category=image");
  static readonly myVideos = new CrUri("cloudreve://my/?category=video");
  static readonly myAudios = new CrUri("cloudreve://my/?category=audio");
  static readonly myDocuments = new CrUri("cloudreve://my/?category=document");
  static readonly sharedWithMe = new CrUri("cloudreve://shared_with_me");
  static readonly sharedByMe = new CrUri("cloudreve://shared_by_me");
  static readonly trash = new CrUri("cloudreve://trash");
}
