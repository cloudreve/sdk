// Separate adversarial composition probe; never substitute fresh-file indexing for this oracle.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Files } from "@cloudreve/sdk/files";
import { Profile } from "@cloudreve/sdk/profile";
import { communityClient, fixture } from "./community-client.mjs";

if (!process.env.CR_FTS_ENDPOINT) {
  throw Error("Set CR_FTS_ENDPOINT to the fixture search service");
}

const f = await fixture();
const client = await communityClient();
const files = new Files(client);
const profile = new Profile(client);
const original = await profile.settings();

const receipt = { image: f.image, result: "pending", samples: [] };
const path = `.artifacts/index-convergence-${randomUUID()}.json`;

let file;

try {
  await profile.patchSettings({
    version_retention_enabled: true,
    version_retention_ext: ["txt"],
    version_retention_max: 5,
  });

  file = await files.create("cloudreve://my/", "index-convergence-" + Date.now() + ".txt", "file");

  const needle = "sdkconvergence" + Date.now();
  const first = await files.saveText(await files.readText(file.path, fetch), needle + " alpha");
  const second = await files.saveText(await files.readText(file.path, fetch), needle + " beta");

  await files.promoteVersion(file.path, first.primary_entity);
  await files.deleteVersion(file.path, second.primary_entity);
  assert.equal((await files.readText(file.path, fetch)).text, needle + " alpha");
  receipt.expectedEntity = first.primary_entity;

  const started = Date.now();
  let matched = false;

  while (Date.now() - started < 60000) {
    const result = await files.fullTextSearch(needle);

    const sample = {
      elapsedMs: Date.now() - started,
      hits: result.hits
        .filter((hit) => hit.file.id === file.id)
        .map((hit) => ({
          entity: hit.file.primary_entity,
          content: hit.content,
        })),
    };

    receipt.samples.push(sample);

    if (receipt.samples.length > 12) {
      receipt.samples.shift();
    }

    if (sample.hits.some((hit) => hit.content.includes("alpha") && !hit.content.includes("beta"))) {
      matched = true;
      break;
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  receipt.result = matched ? "passed" : "failed";
  receipt.elapsedMs = Date.now() - started;
  receipt.current = (await files.info(file.path)).primary_entity;

  const tasks = await fetch(process.env.CR_FTS_ENDPOINT + "/tasks?limit=30");

  receipt.meiliStatus = tasks.status;

  if (tasks.ok) {
    const data = await tasks.json();

    receipt.tasks = data.results?.map((task) => ({
      uid: task.uid,
      type: task.type,
      status: task.status,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      error: task.error,
      details: task.details,
    }));
  }

  assert(matched, "Promoted version index did not converge within60s; see private receipt");
} finally {
  await mkdir(".artifacts", { recursive: true });

  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log(
    JSON.stringify({
      suite: "Version/index convergence",
      result: receipt.result,
      receipt: path,
    }),
  );

  if (file) {
    await files.delete([file.path], true);
  }

  await profile.patchSettings({
    version_retention_enabled: original.version_retention_enabled,
    version_retention_ext: original.version_retention_ext,
    version_retention_max: original.version_retention_max,
  });
}
