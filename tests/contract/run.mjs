import { validateServerVersion } from "@cloudreve/sdk/session";
import { fixture } from "./community-client.mjs";

const f = await fixture();
const server = await validateServerVersion(f.endpoint, fetch);

for (const name of [
  "contract",
  "search",
  "parity",
  "overwrite",
  "public",
  "upload",
  "sharing",
  "profile",
  "text",
  "extended",
  "root",
  "archives",
  "direct-links",
  "share-limits",
]) {
  await import(`./community-${name}.mjs`);
}

if (process.env.CR_GUEST_ARCHIVE_ENABLED === "1") {
  await import("./community-public-archive.mjs");
}

console.log(
  JSON.stringify({
    suite: "SDK Community contracts",
    image: f.image,
    serverVersion: server.version,
    runId: f.id,
    result: "passed",
  }),
);
