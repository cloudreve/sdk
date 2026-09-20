import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { Files, childUri } from "@cloudreve/sdk/files";
import { Uploads, Downloads, aesCtrPosition } from "@cloudreve/sdk/transfers";
import { communityClient, fixture } from "./community-client.mjs";

if (process.env.CR_ENCRYPTION_REQUIRED !== "1") {
  throw Error("Set CR_ENCRYPTION_REQUIRED=1 with an encryption-enabled fixture");
}

const f = await fixture();
const client = await communityClient();
const files = new Files(client);
const uploads = new Uploads(client, fetch);
const downloads = new Downloads(client, fetch);

const folder = await files.create("cloudreve://my/", "sdk-encrypted-" + Date.now(), "folder");

try {
  const policy = (await files.list(folder.path, { page_size: 1 })).storage_policy;

  assert(policy?.id);

  const length = 524291 * 2 + 17;
  const uri = childUri(folder.path, "encrypted.bin");

  let job = await uploads.create(
    {
      uri,
      size: length,
      policy_id: policy.id,
      encryption_supported: ["aes-256-ctr"],
    },
    "local",
  );

  assert(job.session.encrypt_metadata);
  assert.equal(job.session.chunk_size % 16, 3);

  const bytes = (start, end) =>
    Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251);

  const expected = createHash("sha256");

  for (let start = 0; start < length; start += 524291) {
    expected.update(bytes(start, Math.min(length, start + 524291)));
  }

  const seen = [];

  await uploads.run(
    job,
    {
      size: length,
      chunk: async (start, end, encryption) => {
        assert(encryption);

        const { counter, skip } = aesCtrPosition(Buffer.from(encryption.iv, "base64"), start);

        const cipher = createCipheriv(
          "aes-256-ctr",
          Buffer.from(encryption.key_plain_text, "base64"),
          counter,
        );

        cipher.update(new Uint8Array(skip));
        seen.push(start);

        return {
          body: Buffer.concat([cipher.update(bytes(start, end)), cipher.final()]),
          dispose: async () => {},
        };
      },
    },
    async (next) => {
      job = next;
    },
    () => {},
    new AbortController().signal,
  );

  assert(job.completed);
  assert(seen.some((start) => start % 16 !== 0));

  const download = await downloads.prepare(uri);

  let size = 0;
  let hash = createHash("sha256");

  await downloads.run(
    download,
    {
      size: () => size,
      reset: async () => {
        size = 0;
        hash = createHash("sha256");
      },
      append: async (part) => {
        size += part.length;
        hash.update(part);
      },
      close: async () => {},
    },
    async () => {},
    () => {},
    new AbortController().signal,
  );

  assert.equal(size, length);
  assert.equal(hash.digest("hex"), expected.digest("hex"));

  console.log(
    JSON.stringify({
      suite: "SDK encrypted transfer",
      result: "passed",
      image: f.image,
      bytes: length,
      nonalignedChunks: seen.length,
    }),
  );
} finally {
  await files.delete([folder.path], true);
}
