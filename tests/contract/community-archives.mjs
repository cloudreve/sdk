import assert from "node:assert/strict";
import { proofSource } from "./community-client.mjs";
import { Jobs, TaskStatus } from "@cloudreve/sdk/jobs";
import { Files, childUri } from "@cloudreve/sdk/files";

const proof = await proofSource("archive-source");

const client = proof.client;
const jobs = new Jobs(client);
const files = new Files(client);

const folder = await files.create("cloudreve://my/", "Archive contract " + Date.now(), "folder");
const archive = childUri(folder.path, "bundle.zip");
let safeToClean = true;
const source = proof.source.path;

async function complete(task) {
  for (let i = 0; i < 400; i++) {
    const current = await jobs.get(task.id, task.type);

    if (current.status === TaskStatus.completed) {
      return current;
    }

    if (current.status === TaskStatus.error) {
      throw new Error(current.error);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  safeToClean = false;

  throw new Error("Archive task timed out; fixture retained for inspection");
}

try {
  const created = await jobs.archive({ src: [source], dst: archive });

  await complete(created);

  const entries = await jobs.archiveFiles(archive);

  assert(entries.some((x) => x.name === "/" + proof.source.name));

  const destination = await files.create(folder.path, "extracted", "folder");

  const extracted = await jobs.archive(
    {
      src: [archive],
      dst: destination.path,
      file_mask: ["/" + proof.source.name],
    },
    true,
  );

  await complete(extracted);

  const restored = await files.info(childUri(destination.path, proof.source.name));

  assert.equal(restored.size, proof.bytes.length);

  const links = await files.urls([restored.path], true);
  const bytes = new Uint8Array(await fetch(links[0]).then((r) => r.arrayBuffer()));

  assert.deepEqual(bytes, proof.bytes);

  console.log(
    "PASS: owned source -> server ZIP -> selected extraction -> original content hash/bytes",
  );
} finally {
  if (safeToClean) {
    await files.delete([folder.path, proof.source.path], true);
  } else {
    console.log("Retained archive fixture", folder.path);
  }
}
