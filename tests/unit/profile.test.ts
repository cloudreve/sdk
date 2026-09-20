import { expect, it, vi } from "vitest";
import { Profile } from "@cloudreve/sdk/profile";
import { AccountClient } from "@cloudreve/sdk/session";

it("validates profile edits and disposes avatar data after server rejection", async () => {
  const transport = vi.fn(async () =>
    Response.json({ code: 0, data: { id: "user", nickname: "中文" } }),
  );

  const client = new AccountClient({
    accountId: "a",
    endpoint: "https://server.test",
    transport,
    tokens: () => ({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 120000,
    }),
    saveTokens: () => {},
  });

  const profile = new Profile(client);

  await expect(profile.rename(" ")).rejects.toThrow("1–255");
  await expect(profile.password("old", "short")).rejects.toThrow("6–128");
  expect(transport).not.toHaveBeenCalled();
  expect((await profile.rename(" 中文 ")).nickname).toBe("中文");

  const dispose = vi.fn(async () => {});

  transport.mockImplementation(async () => Response.json({ code: 400, msg: "Invalid image" }));

  await expect(
    profile.avatar({
      size: 4,
      chunk: async () => ({ body: new Blob(["data"]), dispose }),
    }),
  ).rejects.toThrow("Invalid image");

  expect(dispose).toHaveBeenCalledOnce();
  await expect(profile.settings()).rejects.toThrow();
});
