import assert from "node:assert/strict";
import { communityClient } from "./community-client.mjs";
import { Files } from "@cloudreve/sdk/files";

const client = await communityClient();
const files = new Files(client);

const created = await files.create(
  "cloudreve://my/",
  "text-contract-" + Date.now() + ".md",
  "file",
);

try {
  const empty = await files.readText(created.path, fetch);

  assert.equal(empty.text, "");

  const source = "# 中文 😀\r\n\r\nText save proof.\r\n";

  await files.saveText({ ...empty, bom: true }, source);

  const first = await files.readText(created.path, fetch);

  assert.equal(first.text, source);
  assert.equal(first.bom, true);
  assert.equal(first.lineEnding, "\r\n");
  await files.saveText(first, source + "Remote change\r\n");
  await assert.rejects(files.saveText(first, "stale edit"), (error) => error.code === 40076);

  const current = await files.readText(created.path, fetch);

  assert(current.text.includes("Remote change"));

  const old = await files.readText(created.path, fetch, first.entity);

  assert.equal(old.text, source);

  console.log(
    "PASS: empty-file editing, UTF-8/BOM/CRLF/emoji preservation, stale-save refusal, historical entity read",
  );
} finally {
  await files.delete([created.path], true);
}
