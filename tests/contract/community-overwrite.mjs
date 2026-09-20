import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Files, backupMetadataKeys } from "@cloudreve/sdk/files";
import { Uploads } from "@cloudreve/sdk/transfers";
import { communityClient, fixture } from "./community-client.mjs";

const f = await fixture();
const client = await communityClient();
const files = new Files(client);
const uploads = new Uploads(client, fetch);

const file = await files.create("cloudreve://my/", "sdk-overwrite-" + Date.now() + ".txt", "file");

try {
  const policy = (await files.list("cloudreve://my/", { page_size: 1 })).storage_policy;
  const original = (await files.info(file.path)).primary_entity;

  const spec = {
    uri: file.path,
    size: 3,
    policy_id: policy.id,
    entity_type: "version",
    previous: original,
  };

  let job = await uploads.create(spec, "local");

  assert.equal(job.spec.previous, original);

  // Expired-checkpoint recovery must preserve the original conflict precondition.
  job.session.expires = 1;

  await uploads.run(
    job,
    {
      size: 3,
      chunk: async () => ({
        body: new TextEncoder().encode("new"),
        dispose: async () => {},
      }),
    },
    async (next) => {
      job = next;
    },
    () => {},
    new AbortController().signal,
  );

  assert(job.completed);

  const verified = await files.readText(file.path, fetch);

  assert.equal(verified.text, "new");

  await files.metadata(
    [file.path],
    [
      {
        key: backupMetadataKeys.sha256,
        value: createHash("sha256").update(verified.text).digest("hex"),
      },
      { key: backupMetadataKeys.entity, value: verified.entity },
    ],
  );

  assert.equal((await files.info(file.path)).metadata[backupMetadataKeys.entity], verified.entity);
  await assert.rejects(uploads.create(spec, "local"), (error) => error.code === 40076);
  assert.equal((await files.readText(file.path, fetch)).text, "new");

  console.log(
    JSON.stringify({
      suite: "SDK binary version upload",
      result: "passed",
      image: f.image,
      renewed: true,
      staleRejected: true,
    }),
  );
} finally {
  await files.delete([file.path], true);
}
