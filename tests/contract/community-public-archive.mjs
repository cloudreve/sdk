import assert from "node:assert/strict";
import { createPublicClient } from "@cloudreve/sdk";
import { Files, CrUri, childUri } from "@cloudreve/sdk/files";
import { Shares } from "@cloudreve/sdk/shares";
import { Uploads } from "@cloudreve/sdk/transfers";
import { Jobs, TaskStatus } from "@cloudreve/sdk/jobs";
import { proofSource } from "./community-client.mjs";

const proof = await proofSource("guest-archive");
const client = proof.client;
const files = new Files(client);
const shares = new Shares(client);
const jobs = new Jobs(client);

const folder = await files.create("cloudreve://my/", "Public ZIP " + Date.now(), "folder");
let id;

const guest = createPublicClient({
  endpoint: client.endpoint,
  transport: async (url, options) => {
    assert(!new Headers(options.headers).has("Authorization"));
    assert(!new Headers(options.headers).has("Cookie"));
    assert.equal(options.credentials, "omit");

    return fetch(url, options);
  },
});

try {
  await files.copyTo(proof.source.path, folder.path, { copy: true });

  const link = await shares.save({
    uri: folder.path,
    is_private: true,
    password: "Fixture42",
  });

  id = new URL(link).pathname.split("/")[2];

  const url = await guest.files.archiveUrl([CrUri.share(id, "Fixture42").toString()]);
  const response = await fetch(url, { credentials: "omit", redirect: "error" });

  assert(response.ok);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const zip = childUri(folder.path, "received.zip");

  const policy = (await files.list(folder.path)).storage_policy;

  const uploads = new Uploads(client, fetch);

  const checkpoint = await uploads.create(
    { uri: zip, size: bytes.length, policy_id: policy.id },
    policy.type,
  );

  await uploads.run(
    checkpoint,
    {
      size: bytes.length,
      chunk: async (start, end) => ({
        body: bytes.slice(start, end),
        dispose: async () => {},
      }),
    },
    async () => {},
    () => {},
    new AbortController().signal,
  );

  const entries = await jobs.archiveFiles(zip);

  const member = entries.find(
    (entry) => !entry.is_directory && entry.name.endsWith("/" + proof.source.name),
  );

  assert(member, "Guest ZIP did not contain selected source");

  const destination = await files.create(folder.path, "restored", "folder");
  const guestRoot = CrUri.share(id, "Fixture42").toString();

  await assert.rejects(guest.files.archiveUrl([guestRoot]), /omit folder descendants/);
  await assert.rejects(guest.files.archiveUrl([childUri(guestRoot, "restored")]), { code: 40082 });

  const task = await jobs.archive(
    { src: [zip], dst: destination.path, file_mask: [member.name] },
    true,
  );

  let complete = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await jobs.get(task.id, task.type);

    if (current.status === TaskStatus.completed) {
      complete = true;
      break;
    }

    if (current.status === TaskStatus.error) {
      throw Error("Guest ZIP extraction failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert(complete, "Guest ZIP extraction did not complete");

  const restored = member.name
    .split("/")
    .filter(Boolean)
    .reduce((parent, name) => childUri(parent, name), destination.path);

  const [resultUrl] = await files.urls([restored], true);

  assert.deepEqual(new Uint8Array(await (await fetch(resultUrl)).arrayBuffer()), proof.bytes);

  console.log(
    JSON.stringify({
      guestFileOnlyRootArchive: true,
      guestDirectoryArchiveRejected: true,
      noAmbientCredentials: true,
      extractedBytesMatch: true,
    }),
  );
} finally {
  guest.dispose();

  if (id) {
    await shares.revoke(id);
  }

  await files.delete([folder.path, proof.source.path], true);
  client.invalidate();
}
