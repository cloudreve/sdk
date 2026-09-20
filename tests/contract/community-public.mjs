import assert from "node:assert/strict";
import { createPublicClient } from "@cloudreve/sdk";
import { Files, CrUri, childUri } from "@cloudreve/sdk/files";
import { Shares } from "@cloudreve/sdk/shares";
import { communityClient, fixture } from "./community-client.mjs";

const f = await fixture();
const owner = await communityClient();
const files = new Files(owner);
const shares = new Shares(owner);

const folder = await files.create("cloudreve://my/", "sdk-public-" + Date.now(), "folder");

let id;
let rangeResumed = false;

const guest = createPublicClient({
  endpoint: f.endpoint,
  transport: async (url, init) => {
    assert(!new Headers(init.headers).has("Authorization"));
    assert(!new Headers(init.headers).has("Cookie"));
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");

    const response = await fetch(url, init);

    if (new Headers(init.headers).has("Range")) {
      assert.equal(response.status, 206);
      rangeResumed = true;
    }

    return response;
  },
});

try {
  const file = await files.create(folder.path, "Note.txt", "file");

  await files.saveText(await files.readText(file.path, fetch), "Guest proof");

  const link = await shares.save({
    uri: folder.path,
    is_private: true,
    password: "Password42",
  });

  id = new URL(link).pathname.split("/")[2];
  assert.equal((await guest.shares.resolve(id)).unlocked, false);
  assert.equal((await guest.shares.resolve(id, "wrong")).unlocked, false);
  assert.equal((await guest.shares.resolve(id, "Password42")).unlocked, true);

  const uri = CrUri.share(id, "Password42").toString();
  const path = childUri(uri, "Note.txt");

  assert.equal((await guest.files.list(uri)).files[0].name, "Note.txt");
  assert.equal((await guest.files.info(path)).name, "Note.txt");

  const [url] = await guest.files.urls([path], true);

  assert.equal(await (await fetch(url)).text(), "Guest proof");

  const checkpoint = await guest.downloads.prepare(path);

  assert.equal(checkpoint.scope, "guest");
  assert(!checkpoint.uri.includes("Password42"));
  assert(!("accountId" in checkpoint));

  let partial = "Gue";
  const saved = [];

  const completed = await guest.downloads.run(
    checkpoint,
    {
      size: () => partial.length,
      reset: async () => {
        partial = "";
      },
      append: async (bytes) => {
        partial += new TextDecoder().decode(bytes);
      },
      close: async () => {},
    },
    async (next) => saved.push(next),
    () => {},
    new AbortController().signal,
    { password: "Password42" },
  );

  assert.equal(partial, "Guest proof");
  assert(rangeResumed);
  assert(completed.completed);
  assert(!JSON.stringify(saved).includes("Password42"));
  await assert.rejects(guest.files.list(CrUri.share(id, "wrong").toString()));

  for (const operation of [
    () => guest.files.list("cloudreve://my/"),
    () => guest.files.info(file.path),
    () => guest.files.urls([path, file.path]),
  ]) {
    await assert.rejects(operation);
  }

  assert.equal((await guest.account.userInfo(owner.accountId)).id, owner.accountId);
  assert(Array.isArray((await guest.shares.publicList(owner.accountId)).shares));
  assert(!("create" in guest.files));
  assert(!("settings" in guest.account));
  assert(!("session" in guest));

  console.log(
    JSON.stringify({
      suite: "SDK anonymous share access",
      result: "passed",
      image: f.image,
      locked: true,
      wrongPasswordDenied: true,
      correctPasswordRead: true,
      namespaceBoundary: true,
      noCredentials: true,
      guestRangeResume: rangeResumed,
      passwordFreeCheckpoints: true,
    }),
  );
} finally {
  guest.dispose();

  if (id) {
    await shares.revoke(id);
  }

  await files.delete([folder.path], true);
}
