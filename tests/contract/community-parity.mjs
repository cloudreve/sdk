import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Files, CrUri } from "@cloudreve/sdk/files";
import { Profile } from "@cloudreve/sdk/profile";
import { Shares } from "@cloudreve/sdk/shares";
import { Authentication } from "@cloudreve/sdk/session";
import { communityClient, fixture } from "./community-client.mjs";

const f = await fixture();
const client = await communityClient();
const files = new Files(client);
const profile = new Profile(client);
const shares = new Shares(client);
const auth = new Authentication(f.endpoint, fetch);

const folder = await files.create("cloudreve://my/", `sdk-parity-${Date.now()}`, "folder");
const original = await profile.settings();
let shareIds = [];

async function until(fn) {
  for (let i = 0; i < 240; i++) {
    const result = await fn();

    if (result) {
      return result;
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw Error("Timed out waiting for owned fixture state");
}

function otp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";

  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }

  const key = Buffer.from(bits.match(/.{8}/g).map((v) => parseInt(v, 2)));
  const step = Buffer.alloc(8);

  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));

  const hash = createHmac("sha1", key).update(step).digest();
  const offset = hash.at(-1) & 15;

  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

async function mailLink(email, kind) {
  return until(async () => {
    const listing = await (
      await fetch(process.env.CR_MAILPIT_ENDPOINT + "/api/v1/messages")
    ).json();

    for (const message of listing.messages ?? []) {
      if (!message.To?.some((to) => to.Address === email)) {
        continue;
      }

      const body = await (
        await fetch(process.env.CR_MAILPIT_ENDPOINT + "/api/v1/message/" + message.ID)
      ).json();

      const text = (body.Text ?? "") + " " + (body.HTML ?? "");

      const link = text
        .replaceAll("&amp;", "&")
        .match(new RegExp(`https?://[^\\s<>"']+/session/${kind}\\?[^\\s<>"']+`));

      if (link) {
        return link[0];
      }
    }

    return undefined;
  });
}

try {
  await profile.patchSettings({
    version_retention_enabled: true,
    version_retention_ext: ["txt"],
    version_retention_max: 5,
    disable_view_sync: false,
    share_links_in_profile: "all_share",
  });

  assert.equal((await profile.settings()).version_retention_max, 5);

  const secret = await profile.initTwoFactor();

  await profile.setTwoFactor(true, otp(secret));
  assert.equal((await profile.settings()).two_fa_enabled, true);
  await profile.setTwoFactor(false, otp(secret));
  assert.equal((await profile.settings()).two_fa_enabled, false);

  const credentials = JSON.parse(await readFile(f.credentialsFile, "utf8"));

  assert((await profile.searchUsers(credentials.email)).some((u) => u.id === client.accountId));
  await files.pin(folder.path, "Parity");
  await files.pin(folder.path, "Parity");
  await assert.rejects(files.pin(folder.path, "Different"));
  await files.unpin(folder.path);
  assert.equal((await files.list(folder.path, { page_size: 1 })).view.page_size, 1);

  const inheritedView = (await files.list(folder.path)).view;

  await files.patchView(folder.path, {
    page_size: 50,
    view: "list",
    order: "name",
    order_direction: "asc",
  });

  assert.equal((await files.list(folder.path)).view.view, "list");
  await files.patchView(folder.path, null);
  assert.deepEqual((await files.list(folder.path)).view, inheritedView);

  const created = await files.create(folder.path, "Note.txt", "file");
  const document = await files.readText(created.path, fetch);
  const first = await files.saveText(document, "cloudreveparitysdkneedle first");

  const second = await files.saveText(
    await files.readText(created.path, fetch),
    "cloudreveparitysdkneedle second",
  );

  await files.promoteVersion(created.path, first.primary_entity);
  assert.equal((await files.readText(created.path, fetch)).text, "cloudreveparitysdkneedle first");
  await files.deleteVersion(created.path, second.primary_entity);

  assert(
    !(await files.info(created.path)).extended_info.entities.some(
      (e) => e.id === second.primary_entity,
    ),
  );

  await files.metadata([created.path], [{ key: "tag:work", value: "#007aff" }]);

  const searched = await files.list(
    new CrUri(folder.path)
      .withSearchParams({
        metadata: [{ key: "tag:work", value: "#007aff", exact: true }],
      })
      .toString(),
  );

  assert.equal(searched.files[0].id, created.id);

  const frames = [];

  for await (const frame of files.listStream(
    new CrUri(folder.path).withSearchParams({ name: ["Note"] }).toString(),
  )) {
    frames.push(frame);
  }

  assert.equal(frames.at(-1).type, "list");

  if (process.env.CR_STREAM_SEARCH === "1") {
    assert(frames.some((e) => e.type === "file"));
  }

  const archive = await files.archiveUrl([created.path]);
  const bytes = new Uint8Array(await (await fetch(archive)).arrayBuffer());

  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  for (let i = 0; i < 2; i++) {
    shareIds.push(new URL(await shares.save({ uri: created.path })).pathname.split("/")[2]);
  }

  assert((await shares.publicList(client.accountId)).shares.some((s) => shareIds.includes(s.id)));
  await shares.revokeMany(shareIds);

  for (const id of shareIds) {
    await assert.rejects(shares.resolve(id));
  }

  shareIds = [];

  if (process.env.CR_PARITY_SERVICES) {
    const indexed = await files.create(folder.path, "indexed.txt", "file");
    const needle = "cloudreveparityfresh" + Date.now();

    await files.saveText(await files.readText(indexed.path, fetch), needle + " searchable content");

    await until(async () => {
      const result = await files.fullTextSearch(needle);

      return result.hits.some((hit) => hit.file.id === indexed.id);
    });

    const events = files.events(folder.path, randomUUID(), {
      timeoutMs: 10000,
    });

    assert(["subscribed", "resumed"].includes((await events.next()).value.type));
    await files.create(folder.path, "event.txt", "file");

    const event = await events.next();

    assert.equal(event.value.type, "event");
    await events.return();

    const email = `parity-${Date.now()}@example.test`;
    const password = "Disposable12!";

    const registration = await auth.register({ email, password });

    if (process.env.CR_EMAIL_ACTIVATION === "1") {
      assert.equal(registration.status, "activationRequired");
      await auth.activate(await mailLink(email, "activate"));
    } else {
      assert.equal(registration.status, "active");
    }

    assert.equal((await auth.password(email, password)).kind, "authenticated");
    await auth.resetPassword(email);

    const reset = await mailLink(email, "reset");

    await auth.redeemPasswordResetLink(reset, "Changed123!");
    await assert.rejects(auth.redeemPasswordResetLink(reset, "Changed456!"));
    assert.equal((await auth.password(email, "Changed123!")).kind, "authenticated");
  }

  console.log(
    JSON.stringify({
      suite: "SDK Community parity",
      result: "passed",
      image: f.image,
      settings: true,
      twoFactor: true,
      versions: true,
      pins: true,
      views: true,
      metadataSearch: true,
      streamSearch: process.env.CR_STREAM_SEARCH === "1",
      temporaryZip: true,
      shareBatch: true,
      optionalServices: !!process.env.CR_PARITY_SERVICES,
    }),
  );
} finally {
  for (const id of shareIds) {
    await shares.revoke(id);
  }

  await files.unpin(folder.path);

  await profile.patchSettings({
    version_retention_enabled: original.version_retention_enabled,
    version_retention_ext: original.version_retention_ext,
    version_retention_max: original.version_retention_max,
    disable_view_sync: original.disable_view_sync,
    share_links_in_profile: original.share_links_in_profile,
  });

  await files.delete([folder.path], true);
}
