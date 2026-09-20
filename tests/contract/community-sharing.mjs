import assert from "node:assert/strict";
import { communityClient } from "./community-client.mjs";
import { Files } from "@cloudreve/sdk/files";
import { Shares, shareSourceUri } from "@cloudreve/sdk/shares";
import { WebDAV, davOptions } from "@cloudreve/sdk/webdav";
import { request } from "@cloudreve/sdk/protocol";

const client = await communityClient();
const files = new Files(client);
const shares = new Shares(client);
const dav = new WebDAV(client);

const source = await files.create(
  "cloudreve://my/",
  "sharing-contract-" + Date.now() + ".txt",
  "file",
);

let shareId;
let davId;

try {
  const link = await shares.save({
    uri: source.path,
    is_private: true,
    password: "Private42",
    expire: 600,
    downloads: 2,
  });

  shareId = new URL(link).pathname.split("/")[2];

  const info = await shares.info(shareId);

  assert.equal((await files.info(shareSourceUri(info))).id, source.id);
  assert.equal(info.password, "Private42");
  assert.equal(info.remain_downloads, 2);

  const anonymous = async (password = "") =>
    request(
      fetch,
      client.endpoint +
        "/api/v4/share/info/" +
        shareId +
        "?password=" +
        encodeURIComponent(password),
    );

  assert.equal((await anonymous()).unlocked, false);
  assert.equal((await anonymous("wrong")).unlocked, false);
  assert.equal((await anonymous("Private42")).unlocked, true);

  await shares.save(
    {
      uri: shareSourceUri(info),
      is_private: true,
      password: "Private42",
      downloads: 0,
      expire: 0,
    },
    shareId,
  );

  const updatedShare = await shares.info(shareId);

  assert.equal(updatedShare.remain_downloads, undefined);
  assert.equal(updatedShare.expires, undefined);
  await shares.revoke(shareId);
  await assert.rejects(anonymous);
  shareId = undefined;

  const publicLink = await shares.save({ uri: source.path });

  shareId = new URL(publicLink).pathname.split("/")[2];
  assert.equal((await anonymous()).unlocked, true);
  await shares.revoke(shareId);
  shareId = undefined;

  const created = await dav.save({
    name: "Contract DAV",
    uri: "cloudreve://my/",
    readonly: true,
    disable_sys_files: true,
  });

  davId = created.id;
  assert.equal(davOptions(created).readonly, true);
  assert((await dav.list()).accounts.some((a) => a.id === davId));

  const updated = await dav.save(
    {
      name: "Updated DAV",
      uri: "cloudreve://my/",
      readonly: false,
      disable_sys_files: true,
    },
    davId,
  );

  assert.equal(updated.name, "Updated DAV");
  assert.equal(davOptions(updated).readonly, false);

  const profile = await client.request("/api/v4/site/config/basic");

  const headers = {
    Authorization: "Basic " + btoa(profile.user.email + ":" + created.password),
    Depth: "0",
  };

  assert.equal(
    (await fetch(client.endpoint + "/dav/", { method: "PROPFIND", headers })).status,
    207,
  );

  await dav.revoke(davId);

  assert.equal(
    (await fetch(client.endpoint + "/dav/", { method: "PROPFIND", headers })).status,
    401,
  );

  davId = undefined;

  console.log(
    "PASS: private/public share, limits, update/revoke, WebDAV CRUD and actual DAV credential acceptance/revocation",
  );
} finally {
  if (shareId) {
    await shares.revoke(shareId);
  }

  if (davId) {
    await dav.revoke(davId);
  }

  await files.delete([source.path], true);
}
