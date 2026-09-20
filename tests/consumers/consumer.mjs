import { Profile } from "@cloudreve/sdk/profile";
import { Jobs, ListTaskCategory } from "@cloudreve/sdk/jobs";
import { Shares } from "@cloudreve/sdk/shares";
import { WebDAV } from "@cloudreve/sdk/webdav";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Files } from "@cloudreve/sdk/files";
import { AccountClient } from "@cloudreve/sdk/session";

const requests = [];

const client = new AccountClient({
  accountId: "node",
  endpoint: "https://example.test",
  tokens: () => ({
    accessToken: "a",
    refreshToken: "r",
    accessExpiresAt: Date.now() + 60000,
    refreshExpiresAt: Date.now() + 120000,
  }),
  saveTokens: () => {},
  transport: async (url, init) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : undefined });

    if (url.endsWith("/user/me")) {
      return Response.json({
        code: 0,
        data: { id: "node-user", nickname: "CLI profile" },
      });
    }

    if (url.includes("/share?") || url.includes("/devices/dav?") || url.includes("/workflow?")) {
      return Response.json({
        code: 0,
        data: {
          shares: null,
          accounts: null,
          tasks: null,
          pagination: { page: 0, page_size: 50 },
        },
      });
    }

    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          id: "id",
          name: "中文.txt",
          path: "cloudreve://my/中文.txt",
          type: 0,
          size: 0,
          created_at: "",
          updated_at: "",
        },
      }),
    );
  },
});

assert.equal(
  (await new Files(client).create("cloudreve://my/", "中文.txt", "file")).name,
  "中文.txt",
);

assert.equal(requests[0].body.err_on_conflict, true);
assert.deepEqual((await new Shares(client).list()).shares, []);
assert.deepEqual((await new WebDAV(client).list()).accounts, []);
assert.deepEqual((await new Jobs(client).list(ListTaskCategory.general)).tasks, []);
assert.equal((await new Profile(client).me()).nickname, "CLI profile");
console.log("Packed SDK works in plain Node.");

assert.equal(typeof Files.prototype.copyTo, "function");
assert.equal(typeof Files.prototype.resolveDestination, "function");
assert.equal(typeof Profile.prototype.capacity, "function");

const { createClient, SessionRecordSchema } = await import("@cloudreve/sdk");

assert.equal(typeof SessionRecordSchema, "object");

const facade = await createClient({
  accountId: "offline",
  endpoint: "https://example.test",
  generation: "node",
  store: {
    read: async () => ({ generation: "node", tokens: null }),
    write: async () => {},
  },
  exclusive: async (operation) => operation(),
  transport: async () => {
    throw Error("Unexpected offline request");
  },
});

assert.equal(facade.session.getSnapshot().status, "signedOut");
assert.equal(facade.files, facade.files);

const require = createRequire(import.meta.url);

for (const name of ["@cloudreve/quality", "@cloudreve/testkit"]) {
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
}
