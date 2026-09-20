import assert from "node:assert/strict";
import { Profile } from "@cloudreve/sdk/profile";
import { communityClient } from "./community-client.mjs";

const profile = new Profile(await communityClient());
const before = await profile.me();
const settings = await profile.settings();

assert.equal(typeof settings.passwordless, "boolean");

try {
  assert.equal((await profile.rename("Profile proof 中文")).nickname, "Profile proof 中文");
  await assert.rejects(profile.password("intentionally-wrong-password", "ValidNewPassword42"));
  assert.equal((await profile.me()).id, before.id);
  console.log("Community nickname persistence and wrong-password rejection passed");
} finally {
  await profile.rename(before.nickname);
}
