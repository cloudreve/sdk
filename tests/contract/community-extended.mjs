import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Files, childUri } from "@cloudreve/sdk/files";
import { Profile } from "@cloudreve/sdk/profile";
import { Jobs, TaskStatus } from "@cloudreve/sdk/jobs";
import { Uploads, Downloads } from "@cloudreve/sdk/transfers";
import { communityClient } from "./community-client.mjs";

const client = await communityClient();
const files = new Files(client);
const second = await communityClient(true);

const folder = await files.create("cloudreve://my/", "sdk-extended-" + Date.now(), "folder");
let safeToClean = true;

async function complete(task) {
  for (let i = 0; i < 100; i++) {
    const current = await new Jobs(client).get(task.id, task.type);

    if (current.status === TaskStatus.completed) {
      return;
    }

    if (current.status === TaskStatus.error) {
      throw Error("Archive workflow failed: " + current.error);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  safeToClean = false;

  throw Error("Workflow timeout; owned data retained for the owning harness to clean up");
}

try {
  const original = await files.create(folder.path, "original.txt", "file");

  await files.copyTo(original.path, childUri(folder.path, "renamed.txt"));

  const renamed = childUri(folder.path, "renamed.txt");
  const destination = await files.create(folder.path, "copies", "folder");

  await files.copyTo(renamed, destination.path, {
    copy: true,
    requireDirectory: true,
  });

  await assert.rejects(files.copyTo(renamed, destination.path, { copy: true }), {
    code: 40004,
  });

  assert.equal((await files.list(destination.path)).files.length, 1);
  assert.equal((await files.info(renamed)).id, original.id);
  await assert.rejects(new Files(second).info(renamed));

  const user = await new Profile(client).me();

  assert.equal((await new Profile(client).userInfo(user.id)).id, user.id);
  assert.equal(typeof (await new Profile(client).capacity()).used, "number");

  const policy = (await files.list(folder.path)).storage_policy;

  assert(policy?.id);

  const uploads = new Uploads(client, fetch);
  const downloads = new Downloads(client, fetch);

  let multiLength = 1;

  const bytesFor = (start, end) =>
    Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251);

  for (const run of [0, 1]) {
    const length = run === 0 ? 0 : multiLength;
    const uri = childUri(folder.path, `bytes-${length}.bin`);
    let checkpoint = await uploads.create({ uri, size: length, policy_id: policy.id }, "local");

    await uploads.run(
      checkpoint,
      {
        size: length,
        chunk: async (start, end) => ({
          body: bytesFor(start, end),
          dispose: async () => {},
        }),
      },
      async (next) => {
        checkpoint = next;
      },
      () => {},
      new AbortController().signal,
    );

    assert(checkpoint.completed);

    if (run === 0) {
      multiLength = checkpoint.session.chunk_size + 1;

      assert(
        checkpoint.session.chunk_size > 0 && multiLength <= 256 * 1024 * 1024,
        "Fixture chunk size must be bounded for local contract",
      );
    }

    if (length > checkpoint.session.chunk_size && checkpoint.session.chunk_size > 0) {
      assert(checkpoint.parts.length > 1);
    }

    let actualHash = createHash("sha256");
    let received = 0;

    const downloaded = await downloads.run(
      await downloads.prepare(uri),
      {
        size: () => received,
        reset: async () => {
          actualHash = createHash("sha256");
          received = 0;
        },
        append: async (chunk) => {
          actualHash.update(chunk);
          received += chunk.length;
        },
        close: async () => {},
      },
      async () => {},
      () => {},
      new AbortController().signal,
    );

    assert(downloaded.completed);

    const expectedHash = createHash("sha256");

    for (let start = 0; start < length; start += 65536) {
      expectedHash.update(bytesFor(start, Math.min(start + 65536, length)));
    }

    assert.equal(actualHash.digest("hex"), expectedHash.digest("hex"));
    assert.equal(received, length);

    console.log(
      `Verified streamed ${length}-byte transfer in ${checkpoint.parts.length} acknowledged chunks`,
    );
  }

  const jobs = new Jobs(client);
  const archive = childUri(folder.path, "test.zip");

  await complete(await jobs.archive({ src: [renamed], dst: archive }));
  assert((await jobs.archiveFiles(archive)).some((f) => f.name.endsWith("renamed.txt")));

  const extract = await files.create(folder.path, "extract", "folder");

  await complete(await jobs.archive({ src: [archive], dst: extract.path }, true));
  assert.equal((await files.info(childUri(extract.path, "renamed.txt"))).size, 0);

  console.log(
    "PASS: safe destination semantics, isolated accounts, capacity, zero/binary transfer bytes, archive creation/extraction",
  );
} finally {
  if (safeToClean) {
    await files.delete([folder.path], true);
  }
}
