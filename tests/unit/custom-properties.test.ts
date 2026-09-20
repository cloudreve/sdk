import { it, expect } from "vitest";
import { customPropertyPatch, type CustomProperty } from "../../src/files/index";
import { parseShareLink } from "../../src/shares/index";

const prop = (type: string, more: Partial<CustomProperty> = {}): CustomProperty => ({
  id: "p",
  name: "Property",
  type,
  ...more,
});

it("validates exact Community custom property wire semantics", () => {
  for (const [p, value] of [
    [prop("text", { min: 3, max: 3 }), "中"],
    [prop("text"), ""],
    [prop("link", { min: 3, max: 5 }), "abc"],
    [prop("link", { min: 3 }), ""],
    [prop("number", { min: -2, max: 2 }), "+2"],
    [prop("number"), "1"],
    [prop("number"), ""],
    [prop("rating", { min: 3, max: 5 }), "-1"],
    [prop("boolean"), "true"],
    [prop("boolean"), "false"],
    [prop("select", { options: ["x"] }), "x"],
    [prop("multi_select", { options: ["x"] }), '["x"]'],
    [prop("multi_select"), "null"],
    [prop("multi_select"), "[]"],
  ] as [CustomProperty, string][]) {
    expect(customPropertyPatch(p, value)).toEqual({ key: "props:p", value });
  }

  expect(customPropertyPatch(prop("unknown"), "", true)).toEqual({
    key: "props:p",
    remove: true,
  });
});

it("rejects malformed values/configuration and integer overflow before mutation", () => {
  for (const [p, value] of [
    [prop("text", { min: 4 }), "中"],
    [prop("text", { max: 2 }), "中"],
    [prop("link", { max: 2 }), "url"],
    [prop("number"), "1.5"],
    [prop("number"), " 1"],
    [prop("number"), "-1"],
    [prop("number", { max: 1 }), "2"],
    [prop("number"), "9223372036854775808"],
    [prop("number"), "-9223372036854775809"],
    [prop("rating", { max: 5 }), "6"],
    [prop("rating"), "1.1"],
    [prop("boolean"), "1"],
    [prop("select"), "x"],
    [prop("multi_select"), "{}"],
    [prop("multi_select"), "[1]"],
    [prop("multi_select"), '["x"]'],
    [prop("multi_select"), "bad"],
    [prop("text", { min: 0.5 }), "x"],
    [prop("text", { max: Infinity }), "x"],
  ] as [CustomProperty, string][]) {
    expect(() => customPropertyPatch(p, value)).toThrow();
  }

  expect(() => customPropertyPatch(prop("unknown"), "x")).toThrow("Unsupported");
  expect(() => customPropertyPatch(prop("text"), 1 as never)).toThrow();
  expect(() => customPropertyPatch(null as never, "x")).toThrow();
  expect(() => customPropertyPatch(prop("text"), "x", "false" as never)).toThrow();
});

it("parses short share links without creating a persisted credential-bearing URI", () => {
  const base = "https://server.test";

  expect(parseShareLink(base + "/s/id", base)).toEqual({ id: "id" });

  expect(parseShareLink(base + "/s/id/p%2Fword", base)).toEqual({
    id: "id",
    password: "p/word",
  });

  expect(parseShareLink(base + "/s/id/", base)).toEqual({ id: "id" });

  for (const url of [
    "https://foreign.test/s/id",
    base + "/x/id",
    base + "/s/",
    base + "/s/id/p/extra",
    base + "/s/id?secret=x",
    base + "/s/id#hash",
    "https://u:p@server.test/s/id",
    base + "/s/id/%ZZ",
  ]) {
    expect(() => parseShareLink(url, base)).toThrow();
  }
});

it("exports source-backed icon/entity constants and expands only safe configured viewer URLs", async () => {
  const { customViewerUrl, iconMetadataKeys, EntityType } = await import("../../src/files/index");
  const { backupMetadataKeys } = await import("../../src/files/index");

  expect(backupMetadataKeys).toEqual({
    sha256: "customize:client_sha256",
    entity: "customize:client_sha256_entity",
  });

  const { mediaMetadataKeys } = await import("../../src/files/index");

  expect(mediaMetadataKeys.artist).toBe("music:artist");

  expect(iconMetadataKeys).toEqual({
    emoji: "customize:emoji",
    color: "customize:icon_color",
  });

  expect(EntityType).toEqual({ version: 0, thumbnail: 1, livePhoto: 2 });

  const input = {
    src: "https://storage.test/a?sig=opaque",
    name: "中文",
    id: "f",
    theme: "dark" as const,
  };

  const url = new URL(
    customViewerUrl(
      "https://viewer.test/?src={$src}&raw={$src_raw_base64}&name={$name}&id={$id}&version={$version}&user={$user_id}&display={$user_display_name}&theme={$theme}&dark={$dark}",
      input,
    ),
  );

  expect(url.searchParams.get("src")).toBe(input.src);
  expect(url.searchParams.get("name")).toBe("中文");
  expect(url.searchParams.get("raw")).toBe(btoa(input.src));
  expect(url.searchParams.get("dark")).toBe("1");

  expect(
    customViewerUrl("https://viewer.test/?source={$src_raw}", {
      ...input,
      theme: "light",
      version: "e",
      userId: "u",
      userDisplayName: "User",
    }),
  ).toContain("source=https://storage.test");

  expect(customViewerUrl("vlc://open?src={$src}", input, ["vlc"])).toMatch(/^vlc:/);

  for (const scheme of [
    "javascript",
    "data",
    "file",
    "content",
    "intent",
    "blob",
    "about",
    "vlc",
  ]) {
    expect(() => customViewerUrl(`${scheme}://host`, input)).toThrow();
  }

  expect(() => customViewerUrl("https://u:p@viewer.test", input)).toThrow();

  expect(() =>
    customViewerUrl("https://viewer.test", {
      ...input,
      src: "file:///tmp/file",
    }),
  ).toThrow();

  expect(() =>
    customViewerUrl("https://viewer.test", {
      ...input,
      src: "https://u:p@storage.test",
    }),
  ).toThrow();

  const { parseCredentialLink } = await import("../../src/session/index");

  expect(() =>
    parseCredentialLink("https://server.test/api/v4/user/session/copy/id?sign=secret"),
  ).toThrow("unsupported");
});

it("encodes ephemeral share passwords without mutating the public URI", async () => {
  const { CrUri } = await import("../../src/files/index");

  expect(CrUri.share("id", "secret").password()).toBe("secret");
  expect(CrUri.share("id").id()).toBe("id");
  expect(() => CrUri.share("")).toThrow();

  const publicUri = new CrUri("cloudreve://id@share/folder");
  const secret = publicUri.withPassword("a/b:@密");

  expect(secret.password()).toBe("a/b:@密");
  expect(publicUri.password()).toBe("");
  expect(secret.withPassword("").password()).toBe("");
  expect(() => CrUri.my.withPassword("p")).toThrow("share");
});
