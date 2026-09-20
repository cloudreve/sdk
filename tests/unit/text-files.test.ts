import { it, expect, vi } from "vitest";
import { Files } from "@cloudreve/sdk/files";
import { AccountClient } from "@cloudreve/sdk/session";

const bytes = new TextEncoder().encode("\uFEFF中文\r\n");

const entry = {
  id: "f",
  path: "cloudreve://my/test.txt",
  name: "test.txt",
  type: 0,
  size: bytes.length,
  primary_entity: "v1",
  created_at: "",
  updated_at: "",
};

function fixture(size = bytes.length) {
  const transport = vi.fn(async (url: string, init?: RequestInit) =>
    Response.json({
      code: 0,
      data: url.includes("/file/url")
        ? { urls: [{ url: "https://storage.test/text" }] }
        : {
            ...entry,
            size: url.includes("/file/content")
              ? new TextEncoder().encode(String(init?.body)).length
              : size,
          },
    }),
  );

  return {
    transport,
    files: new Files(
      new AccountClient({
        accountId: "a",
        endpoint: "https://server.test",
        transport,
        tokens: () => ({
          accessToken: "a",
          refreshToken: "r",
          accessExpiresAt: Date.now() + 100000,
          refreshExpiresAt: Date.now() + 200000,
        }),
        saveTokens: () => {},
      }),
    ),
  };
}

it("reads bounded UTF-8 content without bearer credentials and retains BOM/line endings", async () => {
  const f = fixture();

  const document = await f.files.readText(entry.path, async (_url, init) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);

    return new Response(bytes);
  });

  expect(document).toMatchObject({
    text: "中文\r\n",
    entity: "v1",
    bom: true,
    lineEnding: "\r\n",
  });

  await f.files.saveText(document, "Changed\r\n");
  expect(f.transport.mock.lastCall?.[0]).toContain("previous=v1");
});

it("rejects binary, invalid encoding, truncated and oversized responses", async () => {
  await expect(
    fixture(2).files.readText(entry.path, async () => new Response(new Uint8Array([0, 65]))),
  ).rejects.toThrow("binary");

  await expect(
    fixture(1).files.readText(entry.path, async () => new Response(new Uint8Array([255]))),
  ).rejects.toThrow("UTF-8");

  await expect(
    fixture(10).files.readText(entry.path, async () => new Response("short")),
  ).rejects.toThrow("interrupted");

  await expect(
    fixture(1).files.readText(entry.path, async () => new Response("long")),
  ).rejects.toThrow("expected size");

  await expect(
    fixture(6 * 1024 * 1024).files.readText(entry.path, async () => new Response()),
  ).rejects.toThrow("5 MB");
});

it("does not confirm a proxy-truncated save", async () => {
  const f = fixture(0);

  f.transport.mockImplementation(async () =>
    Response.json({ code: 0, data: { ...entry, size: 0 } }),
  );

  await expect(
    f.files.saveText(
      {
        uri: entry.path,
        name: entry.name,
        entity: "v1",
        text: "",
        bom: false,
        lineEnding: "\n",
      },
      "lost body",
    ),
  ).rejects.toThrow("draft has been retained");
});
