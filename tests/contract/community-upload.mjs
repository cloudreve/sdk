import assert from "node:assert/strict";
import { Uploads } from "@cloudreve/sdk/transfers";
import { Files } from "@cloudreve/sdk/files";
import { communityClient } from "./community-client.mjs";

const client = await communityClient();
const files = new Files(client);
const listing = await client.request("/api/v4/file?uri=cloudreve%3A%2F%2Fmy%2F");
const policy = listing.storage_policy;

assert.ok(policy?.id, "Directory offers upload policy");

const bytes = new TextEncoder().encode("SDK upload 中文\n".repeat(100));
const uri = `cloudreve://my/upload-contract-${Date.now()}.txt`;
const uploads = new Uploads(client, fetch);
let job;

try {
  job = await uploads.create(
    { uri, size: bytes.length, policy_id: policy.id, mime_type: "text/plain" },
    "local",
  );

  await uploads.run(
    job,
    {
      size: bytes.length,
      chunk: async (start, end) => ({
        body: bytes.slice(start, end),
        dispose: async () => {},
      }),
    },
    async (next) => {
      job = next;
    },
    () => {},
    new AbortController().signal,
  );

  assert.ok(job.completed);

  const info = await files.info(uri);

  assert.equal(info.size, bytes.length);

  const resolved = await files.urls([uri]);
  const downloaded = new Uint8Array(await (await fetch(resolved[0])).arrayBuffer());

  assert.deepEqual(downloaded, bytes);
  console.log("Community upload and downloaded bytes match exactly.");
} finally {
  if (job?.completed) {
    await files.delete([uri], true);
  } else if (job) {
    await uploads.cancel(job);
  }
}
