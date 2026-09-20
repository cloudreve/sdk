import assert from "node:assert/strict";
import { Files } from "@cloudreve/sdk/files";
import { communityClient } from "./community-client.mjs";

const client = await communityClient();
const files = new Files(client);
const name = `sdk-contract-${Date.now()}`;
let owned;

try {
  owned = await files.create("cloudreve://my/", name, "folder");
  assert.equal((await files.info(owned.path)).id, owned.id);
  await files.rename(owned.path, `${name}-renamed`);

  const listing = await client.request("/api/v4/file?uri=cloudreve%3A%2F%2Fmy%2F");

  owned = listing.files.find((f) => f.id === owned.id);
  assert.equal(owned.name, `${name}-renamed`);

  const child = await files.create(owned.path, "file.txt", "file");

  await assert.rejects(files.create(owned.path, "file.txt", "file"));
  await files.metadata([child.path], [{ key: "tag:Validated", value: "#007AFF" }]);
  assert.equal((await files.info(child.path)).metadata["tag:Validated"], "#007AFF");

  const destination = await files.create(owned.path, "destination", "folder");

  await files.move([child.path], destination.path, true);

  let copied = await files.list(destination.path);

  assert.equal(copied.files.length, 1, "copy creates a file");
  await files.rename(copied.files[0].path, "copy.txt");
  await files.move([child.path], destination.path);
  copied = await files.list(destination.path);
  assert.equal(copied.files.length, 2, "move keeps both distinct files");

  await files.metadata(
    [copied.files.find((f) => f.name === "file.txt").path],
    [{ key: "tag:Validated", remove: true }],
  );

  await assert.rejects(
    files.rename(copied.files.find((f) => f.name === "copy.txt").path, "file.txt"),
  );

  assert.equal(
    (await files.info(copied.files.find((f) => f.name === "file.txt").path)).metadata?.[
      "tag:Validated"
    ],
    undefined,
  );

  console.log("Community file contracts: tag add/remove, copy/move, nested listing passed.");
  await files.delete([owned.path]);

  const trash = await client.request("/api/v4/file?uri=cloudreve%3A%2F%2Ftrash%2F");
  const trashed = trash.files.find((f) => f.id === owned.id);

  assert.ok(trashed, "deleted folder is in trash");
  owned = trashed;
  await files.restore([trashed.path]);

  const restored = await client.request("/api/v4/file?uri=cloudreve%3A%2F%2Fmy%2F");

  owned = restored.files.find((f) => f.id === owned.id);
  assert.ok(owned, "restored folder is reachable");
  console.log("Community contract passed: login, create, info, list, rename, trash, restore.");
} finally {
  if (owned) {
    await files.delete([owned.path], true);
  }
}
