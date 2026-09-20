import assert from "node:assert/strict";
import { Shares } from "@cloudreve/sdk/shares";
import { proofSource } from "./community-client.mjs";

const proof = await proofSource("direct-link");
const shares = new Shares(proof.client);

let created = [];

try {
  assert(await shares.directAllowed());

  const links = await shares.direct(proof.source.path);

  created = (await proof.files.info(proof.source.path)).extended_info.direct_links;
  assert(links.length);
  assert(created.length);

  for (const link of links) {
    const response = await fetch(link.link);

    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), proof.bytes);
  }

  for (const link of created) {
    await shares.revokeDirect(link.id);
  }

  for (const link of created) {
    const response = await fetch(link.url);

    assert.notEqual(response.status, 200);
    await response.body?.cancel();
  }

  created = [];
  console.log("PASS: direct link byte integrity and revoked credentials rejected");
} finally {
  for (const link of created) {
    await shares.revokeDirect(link.id);
  }

  await proof.files.delete([proof.source.path], true);
}
