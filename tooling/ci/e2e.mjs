import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startCommunity, communityIO } from "@cloudreve/testkit/community";
import { metadataFixture } from "@cloudreve/testkit/metadata-fixture";
import { guestArchiveFixture } from "@cloudreve/testkit/guest-archive-fixture";
import { validateServerVersion } from "@cloudreve/sdk/session";
import { linuxDockerDriver } from "./docker-fixture.mjs";
import { communityClient } from "../../tests/contract/community-client.mjs";

const targets = JSON.parse(await readFile(new URL("./community.json", import.meta.url), "utf8"));
const version = process.env.CR_CI_VERSION ?? "4.18.0";
const target = targets.find((item) => item.version === version);

assert(target, "Select a pinned Community version with CR_CI_VERSION");

const runId = process.env.CR_CI_RUN_ID ?? `sdk-ci-${randomUUID()}`;
const directory = resolve(".runtime", runId);

await mkdir(directory, { recursive: true, mode: 0o700 });

const io = linuxDockerDriver(runId);
let lease;
let client;

const receipt = {
  version,
  image: target.image,
  passed: false,
  cleanupPassed: false,
};

try {
  lease = await startCommunity(
    {
      output: resolve(directory, "fixture.json"),
      owner: process.cwd(),
      role: "test",
      image: target.image,
    },
    { driver: io.driver, seed: communityIO.seed },
  );

  process.env.CR_FIXTURE_MANIFEST = resolve(directory, "fixture.json");

  const discovered = await validateServerVersion(lease.manifest.endpoint, fetch);

  assert.equal(discovered.version, version);
  client = await communityClient();

  const request = client.request.bind(client);

  await request("/api/v4/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({ settings: { siteURL: lease.manifest.endpoint } }),
  });

  await metadataFixture(request);
  await guestArchiveFixture(request);
  process.env.CR_GUEST_ARCHIVE_ENABLED = "1";
  await import("../../tests/contract/run.mjs");
  receipt.passed = true;
} finally {
  client?.invalidate();

  if (lease) {
    await lease.close();
    assert(await io.driver.absent(lease.manifest), "Fixture cleanup left owned resources");
  }

  receipt.cleanupPassed = true;
  await mkdir(".artifacts/ci", { recursive: true });
  await writeFile(`.artifacts/ci/community-${version}.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
