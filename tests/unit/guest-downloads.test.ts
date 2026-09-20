import { it, expect, vi } from "vitest";
import { createPublicClient } from "../../src/client";
import { CrUri } from "../../src/files/index";
import { parseGuestDownloadCheckpoint, Downloads } from "../../src/transfers/index";
import { AccountClient } from "../../src/session/index";

const uri = "cloudreve://id:secret@share/x";
const publicUri = "cloudreve://id@share/x";

const file = {
  id: "f",
  name: "x",
  path: publicUri,
  type: 0,
  size: 4,
  primary_entity: "e",
};

it("resumes guest bytes with original entity, renewal and password-free checkpoints", async () => {
  const bodies: Record<string, unknown>[] = [];

  const transport = async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);

    if (url.includes("file/info")) {
      return Response.json({ code: 0, data: file });
    }

    const body = JSON.parse(String(init?.body));

    bodies.push(body);

    return Response.json({
      code: 0,
      data: {
        urls: [
          {
            url: body.no_cache ? "https://storage.test/fresh" : "https://storage.test/expired",
          },
        ],
      },
    });
  };

  const storage = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Range")).toBe("bytes=2-");
    expect(new Headers(init?.headers).get("If-Range")).toBe('"tag"');

    return url.endsWith("expired")
      ? new Response("", { status: 403 })
      : new Response("cd", {
          status: 206,
          headers: { "Content-Range": "bytes 2-3/4", ETag: '"tag"' },
        });
  });

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
    downloadTransport: storage,
  });

  let job = await client.downloads.prepare(uri);

  job = { ...job, etag: '"tag"' };
  expect(job.scope).toBe("guest");
  expect(job.uri).toBe(publicUri);
  expect("accountId" in job).toBe(false);

  let text = "ab";
  const saved: unknown[] = [];

  const result = await client.downloads.run(
    job,
    {
      size: () => text.length,
      reset: async () => {
        text = "";
      },
      append: async (bytes) => {
        text += new TextDecoder().decode(bytes);
      },
      close: async () => {},
    },
    async (next) => {
      saved.push(next);
    },
    () => {},
    new AbortController().signal,
    { password: "secret" },
  );

  expect(text).toBe("abcd");
  expect(result.completed).toBe(true);
  expect(storage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(saved)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(bodies.map((body) => body.entity)).toEqual(["e", "e"]);

  expect(
    bodies.every((body) => new CrUri((body.uris as string[])[0]!).password() === "secret"),
  ).toBe(true);

  client.dispose();
});

it("rejects persisted secrets, mixed identities and namespace/endpoint substitutions", async () => {
  const transport = vi.fn(async () => Response.json({ code: 0, data: file }));

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
  });

  const job = await client.downloads.prepare(uri);

  expect(parseGuestDownloadCheckpoint(job)).toEqual(job);

  for (const invalid of [
    { ...job, uri },
    { ...job, accountId: "a" },
    { ...job, scope: "account" },
    { ...job, uri: "cloudreve://my/private" },
    { ...job, size: -1 },
  ]) {
    expect(() => parseGuestDownloadCheckpoint(invalid)).toThrow();
  }

  await expect(client.downloads.prepare("cloudreve://my/x")).rejects.toThrow("share URI");

  const destination = {
    size: () => 0,
    reset: async () => {},
    append: async () => {},
    close: async () => {},
  };

  await expect(
    client.downloads.run(
      { ...job, endpoint: "https://other.test" },
      destination,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("another endpoint");

  const account = new AccountClient({
    endpoint: "https://server.test",
    accountId: "a",
    transport,
    tokens: () => null,
    saveTokens: () => {},
  });

  await expect(
    new Downloads(account, transport).run(
      { ...job, accountId: "a" } as never,
      destination,
      async () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("another account");

  client.dispose();
});

it("cancels a pending guest storage response and disposes a late body", async () => {
  let resolve!: (response: Response) => void;

  const storage = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );

  const transport = async (url: string) =>
    Response.json({
      code: 0,
      data: url.includes("file/info") ? file : { urls: [{ url: "https://storage.test/file" }] },
    });

  const client = createPublicClient({
    endpoint: "https://server.test",
    transport,
    downloadTransport: storage,
  });

  const job = await client.downloads.prepare(uri);
  const controller = new AbortController();
  const close = vi.fn(async () => {});

  const pending = client.downloads.run(
    job,
    { size: () => 0, reset: async () => {}, append: async () => {}, close },
    async () => {},
    () => {},
    controller.signal,
    { password: "secret" },
  );

  await vi.waitFor(() => expect(storage).toHaveBeenCalled());
  controller.abort();
  await expect(pending).rejects.toThrow("cancel");
  expect(close).toHaveBeenCalled();

  const cancel = vi.fn();

  resolve(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  client.dispose();
});
