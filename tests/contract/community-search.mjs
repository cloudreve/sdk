import assert from "node:assert/strict";
import { Files, CrUri } from "@cloudreve/sdk/files";
import { Shares } from "@cloudreve/sdk/shares";
import { communityClient } from "./community-client.mjs";

const client = await communityClient();
const files = new Files(client);
const shares = new Shares(client);

const folder = await files.create("cloudreve://my/", `sdk-search-${Date.now()}`, "folder");
let shareId;

try {
  const nested = await files.create(folder.path, "nested", "folder");
  const target = await files.create(nested.path, "Note.txt", "file");
  const link = await shares.save({ uri: folder.path });

  shareId = new URL(link).pathname.split("/")[2];

  for (const root of [folder.path, `cloudreve://${shareId}@share/`]) {
    for (const [name, count] of [
      ["Note", 1],
      ["absent-search-result", 0],
    ]) {
      const uri = new CrUri(root).withSearchParams({ name: [name] }).toString();

      const result = await files.list(uri, {
        page_size: 50,
        order_by: "name",
        order_direction: "asc",
      });

      assert.equal(result.files.length, count);

      if (count) {
        assert.equal(result.files[0].id, target.id);
      }

      assert.deepEqual(result.props.order_by_options, []);
      assert.deepEqual(result.props.order_direction_options, []);
    }
  }

  console.log(
    "PASS: recursive own/share search with nonempty and empty results and null sorting capabilities",
  );
} finally {
  if (shareId) {
    await shares.revoke(shareId);
  }

  await files.delete([folder.path], true);
}
