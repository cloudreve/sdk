import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Files, childUri } from "@cloudreve/sdk/files";
import { communityClient } from "./community-client.mjs";

const client = await communityClient();
const files = new Files(client);
const root = "cloudreve://my/";

const name = `sdk-root-${randomUUID()}`;
let current;

try {
  assert.equal((await files.info(root)).type, 1);

  const created = await files.create(root, name, "file");

  current = created.path;

  const target = childUri(root, name + "-renamed");

  assert.equal((await files.copyTo(current, target)).operation, "rename");
  current = target;
  assert.equal((await files.info(current)).id, created.id);

  assert.deepEqual(await files.resolveDestination("new.txt", root, true), {
    uri: childUri(root, "new.txt"),
    parent: root,
  });

  console.log(
    JSON.stringify({
      rootStat: true,
      rootRename: true,
      rootUploadDestination: true,
    }),
  );
} finally {
  if (current) {
    await files.delete([current], true);
  }

  client.invalidate();
}
