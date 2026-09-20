import { expect, it } from "vitest";
import { fileActions, Files, CrUri, type FileEntry } from "../../src/files/index";
import { AccountClient } from "../../src/session/index";

const file: FileEntry = {
  id: "a",
  name: "a",
  path: "cloudreve://my/a",
  type: 0,
  size: 0,
  created_at: "",
  updated_at: "",
  owned: true,
  capability: btoa(String.fromCharCode(255, 255, 255)),
};

it("gates mutations by ownership and capabilities", () => {
  expect(fileActions(file)).toMatchObject({
    rename: true,
    delete: true,
    metadata: true,
  });

  expect(fileActions({ ...file, owned: false })).toMatchObject({
    rename: false,
    delete: false,
    metadata: false,
  });

  expect(fileActions({ ...file, path: "cloudreve://secret@share/a" }).rename).toBe(false);
  expect(fileActions({ ...file, path: "cloudreve://my/file@share/a" }).rename).toBe(true);
});

it("rejects executable preview URLs", async () => {
  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://example.test",
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
    transport: async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { urls: [{ url: "javascript:alert(1)" }] },
        }),
      ),
  });

  await expect(new Files(client).urls([file.path])).rejects.toThrow("Unsupported");
});

it("keeps search filters in the portable URI contract", () => {
  const uri = CrUri.my.withSearchParams({
    name: ["中文"],
    type: "file",
    sizeGte: 1024,
    updatedGte: 1700000000,
    caseFolding: true,
  });

  expect(new URL(uri.toString()).searchParams.get("type")).toBe("file");

  expect(new CrUri(uri.toString()).searchParams()).toMatchObject({
    name: ["中文"],
    type: "file",
    sizeGte: 1024,
    updatedGte: 1700000000,
    caseFolding: true,
  });
});

it("requires explicit permanent deletion for trash items", async () => {
  let requests = 0;

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://a.test",
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
    transport: async () => {
      requests++;

      return new Response(JSON.stringify({ code: 0, data: null }));
    },
  });

  const files = new Files(client);

  await expect(files.delete(["cloudreve://trash/old.txt"])).rejects.toThrow(
    "explicit permanent deletion",
  );

  expect(requests).toBe(0);
  await files.delete(["cloudreve://trash/old.txt"], true);
  expect(requests).toBe(1);
});
