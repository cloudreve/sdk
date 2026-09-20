import { expect, it } from "vitest";
import { tagPatches } from "@cloudreve/sdk/files";

it("replaces the old tag atomically and removes the original when the form is discarded as removal", () => {
  expect(tagPatches("New", "#112233")).toEqual([{ key: "tag:New", value: "#112233" }]);

  expect(tagPatches(" Reviewed 中文 ", "#007AFF", "Review")).toEqual([
    { key: "tag:Review", remove: true },
    { key: "tag:Reviewed 中文", value: "#007AFF" },
  ]);

  expect(tagPatches("Typed replacement", "invalid", "Review", true)).toEqual([
    { key: "tag:Review", remove: true },
  ]);

  expect(() => tagPatches(" ", "#007AFF")).toThrow("tag name");
  expect(() => tagPatches("Review", "bad")).toThrow("color");
});
