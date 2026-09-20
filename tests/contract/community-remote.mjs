import assert from "node:assert/strict";
import { Jobs, TaskStatus, canCancelTask } from "@cloudreve/sdk/jobs";
import { Files, childUri } from "@cloudreve/sdk/files";
import { Uploads } from "@cloudreve/sdk/transfers";
import { fixture, communityClient } from "./community-client.mjs";

const f = await fixture();
const remote = f.remoteJob;

if (!remote?.completionSource || !remote.torrentSource) {
  throw Error("A fixture with remote-download services is required");
}

const client = await communityClient();
const jobs = new Jobs(client);
const files = new Files(client);

const destination = await files.create(remote.destination, "sdk-remote-" + Date.now(), "folder");

const created = await jobs.createDownload({
  src: [remote.completionSource],
  dst: destination.path,
});

assert.equal(created.length, 1);

async function waitCompleted(task) {
  for (let i = 0; i < 200; i++) {
    const current = await jobs.get(task.id, task.type);

    if (current.status === TaskStatus.completed) {
      return;
    }

    assert.notEqual(
      current.status,
      TaskStatus.error,
      `Owned remote task failed: ${current.error ?? current.summary?.phase ?? "unknown"}`,
    );

    await new Promise((r) => setTimeout(r, 300));
  }

  throw Error("Owned remote task did not complete within60s");
}

await waitCompleted(created[0]);

assert.equal(
  (await files.readText(childUri(destination.path, "complete.txt"), fetch)).text,
  "Cloudreve remote acceptance\n",
);

const torrentResponse = await fetch(remote.torrentSource, {
  redirect: "error",
});

assert.equal(torrentResponse.status, 200, "Owned torrent fixture is unavailable");

const torrent = new Uint8Array(await torrentResponse.arrayBuffer());

assert(torrent.length > 0 && torrent.length < 1024 * 1024, "Expected bounded owned metainfo");

const policy = (await files.list(destination.path, { page_size: 1 })).storage_policy;

assert(policy?.id);

const torrentUri = childUri(destination.path, "fixture.torrent");
const uploads = new Uploads(client, fetch);

let upload = await uploads.create(
  {
    uri: torrentUri,
    size: torrent.length,
    policy_id: policy.id,
    mime_type: "application/x-bittorrent",
  },
  "local",
);

await uploads.run(
  upload,
  {
    size: torrent.length,
    chunk: async (start, end) => ({
      body: torrent.subarray(start, end),
      dispose: async () => {},
    }),
  },
  async (next) => {
    upload = next;
  },
  () => {},
  new AbortController().signal,
);

assert(upload.completed);
assert.equal((await files.info(torrentUri)).size, torrent.length);

const torrentDestination = await files.create(destination.path, "torrent-result", "folder");

const torrentJobs = await jobs.createDownload({
  src_file: torrentUri,
  dst: torrentDestination.path,
});

assert.equal(torrentJobs.length, 1);
await waitCompleted(torrentJobs[0]);

assert.equal(
  (await files.readText(childUri(torrentDestination.path, "complete.txt"), fetch)).text,
  "Cloudreve remote acceptance\n",
);

const slow = await jobs.createDownload({
  src: [remote.source],
  dst: destination.path,
});

let cancellable;

for (let i = 0; i < 100; i++) {
  const task = await jobs.get(slow[0].id, slow[0].type);

  if (canCancelTask(task)) {
    cancellable = task;
    break;
  }

  await new Promise((r) => setTimeout(r, 200));
}

assert(cancellable, "Owned task did not enter cancellable phase");
await jobs.cancel(cancellable);
await files.delete([destination.path], true);
assert.equal(await files.infoIfExists(destination.path), undefined);

console.log(
  JSON.stringify({
    suite: "SDK remote download creation",
    result: "passed",
    image: f.image,
    completedBytes: true,
    cancelled: true,
    torrentSourceFile: true,
    torrentBytesVerified: true,
    removedOwnedData: true,
  }),
);
