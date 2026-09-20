import assert from "node:assert/strict";
import { proofSource } from "./community-client.mjs";
import { Shares } from "@cloudreve/sdk/shares";
import { request } from "@cloudreve/sdk/protocol";

const proof = await proofSource("share-limit");

const client = proof.client;
const shares = new Shares(client);
const ids = [];

try {
  const link = await shares.save({
    uri: proof.source.path,
    downloads: 1,
  });

  const id = new URL(link).pathname.split("/")[2];

  ids.push(id);

  const resolve = () =>
    request(fetch, client.endpoint + "/api/v4/file/url", {
      method: "POST",
      body: JSON.stringify({
        uris: [`cloudreve://${id}@share/${encodeURIComponent(proof.source.name)}`],
        download: true,
      }),
    });

  const result = await resolve();

  assert(result.urls.length);

  const downloaded = await fetch(result.urls[0].url);

  assert.equal(downloaded.status, 200);
  await downloaded.arrayBuffer();
  await assert.rejects(resolve);

  const expires = await shares.save({
    uri: proof.source.path,
    expire: 1,
  });

  const expiredId = new URL(expires).pathname.split("/")[2];

  ids.push(expiredId);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(request(fetch, client.endpoint + "/api/v4/share/info/" + expiredId));

  console.log(
    "PASS: anonymous one-download limit and timed expiration enforced by community server",
  );
} finally {
  for (const id of ids) {
    await shares.revoke(id);
  }

  await proof.files.delete([proof.source.path], true);
}
