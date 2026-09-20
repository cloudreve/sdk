import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { verifyInstalledPackage } from "@cloudreve/quality/artifacts";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = process.cwd();
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const filename = `cloudreve-sdk-${version}.tgz`;

const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

run("bun", ["run", "build"]);
mkdirSync(".artifacts", { recursive: true });
run("bun", ["pm", "pack", "--destination", ".artifacts"]);

const tarball = resolve(".artifacts", filename);
const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");

writeFileSync(tarball + ".sha256", `${checksum}  ${filename}\n`);

const namedArtifact = resolve(`.artifacts/cloudreve-sdk-${version}-${checksum.slice(0, 12)}.tgz`);

copyFileSync(tarball, namedArtifact);
writeFileSync(namedArtifact + ".sha256", `${checksum}  ${basename(namedArtifact)}\n`);

const consumer = mkdtempSync(join(tmpdir(), "cloudreve-sdk-consumer-"));

copyFileSync(tarball, resolve(consumer, "sdk.tgz"));

writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@cloudreve/sdk": "file:./sdk.tgz" },
  }),
);

run("bun", ["install", "--ignore-scripts"], consumer);
copyFileSync("tests/consumers/consumer.mjs", resolve(consumer, "consumer.mjs"));
run("node", ["consumer.mjs"], consumer);

const exports = Object.keys(JSON.parse(readFileSync("package.json")).exports)
  .filter((x) => x !== ".")
  .map((x) => x.slice(2));

writeFileSync(
  resolve(consumer, "types.mts"),
  exports
    .map((x, i) => `import * as module${i} from "@cloudreve/sdk/${x}";\nexport { module${i} };`)
    .join("\n"),
);

run(
  "node",
  [
    resolve("node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--module",
    "nodenext",
    "--target",
    "es2022",
    "types.mts",
  ],
  consumer,
);

run(
  "node",
  [
    resolve("node_modules/esbuild/bin/esbuild"),
    "types.mts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--outfile=bundle.js",
  ],
  consumer,
);

const installed = resolve(consumer, "node_modules/@cloudreve/sdk");

await verifyInstalledPackage(tarball, installed);

assert.deepEqual(
  readdirSync(installed).sort(),
  ["LICENSE", "README.md", "dist", "docs", "package.json", "src"].sort(),
);

writeFileSync(
  resolve(consumer, "private.mjs"),
  `import assert from 'node:assert/strict';\nawait assert.rejects(import('@cloudreve/sdk/src/files/index.ts'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`,
);

run("node", ["private.mjs"], consumer);
console.log(`Artifact: ${namedArtifact}\nSHA256: ${checksum}\nIsolated consumer: ${consumer}`);
