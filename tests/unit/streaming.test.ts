import { it, expect, vi } from "vitest";
import { AccountClient } from "../../src/session/index";
import { Files } from "../../src/files/index";
import { readSSE, streamValues, ApiError } from "../../src/protocol/index";

const file = {
  id: "f",
  name: "中文",
  path: "cloudreve://my/n",
  type: 0,
  size: 0,
};

const directory = {
  files: null,
  pagination: { page: 0, page_size: 50 },
  props: {},
};

const enc = new TextEncoder();

function response(text: string, chunk = 10000, cancel = vi.fn()) {
  const bytes = enc.encode(text);
  let offset = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (offset === bytes.length) {
          c.close();
        } else {
          c.enqueue(bytes.slice(offset, offset + chunk));
          offset = Math.min(bytes.length, offset + chunk);
        }
      },
      cancel,
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function client(transport: (url: string, init?: RequestInit) => Promise<Response>) {
  return new AccountClient({
    accountId: "u",
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
}

async function collect<T>(iter: AsyncIterable<T>) {
  const values: T[] = [];

  for await (const value of iter) {
    values.push(value);
  }

  return values;
}

it("parses fragmented UTF-8, comments, CRLF/CR and multiline data with bounded frames", async () => {
  const frames = await collect(
    readSSE(
      response(
        ": comment\r\nevent: file\r\ndata: 中文\r\ndata:second\r\n\r\nignored\rid:1\rdata\r\r",
        1,
      ),
      new AbortController().signal,
    ),
  );

  expect(frames).toEqual([
    { event: "file", data: "中文\nsecond" },
    { event: "message", data: "" },
  ]);

  for (const text of [
    "data:incomplete",
    "data:a\n",
    "x".repeat(8 * 1024 * 1024 + 1),
    "data:" + "x".repeat(8 * 1024 * 1024) + "\n\n",
  ]) {
    await expect(
      collect(readSSE(response(text, 16 * 1024 * 1024), new AbortController().signal)),
    ).rejects.toThrow();
  }

  await expect(collect(readSSE({ body: null }, new AbortController().signal))).rejects.toThrow(
    "unavailable",
  );
});

it("maintains one-item backpressure and releases the producer on early return", async () => {
  const produced: number[] = [];
  let ended = false;

  const iterator = streamValues<number>(async (emit) => {
    try {
      for (const value of [1, 2, 3]) {
        produced.push(value);
        await emit(value);
      }
    } finally {
      ended = true;
    }
  });

  expect(produced).toEqual([]);
  expect((await iterator.next()).value).toBe(1);
  await Promise.resolve();
  expect(produced).toEqual([1]);
  await iterator.return();
  expect(ended).toBe(true);
  expect(produced).toEqual([1]);

  expect(
    await collect(
      streamValues(async (emit) => {
        await emit(1);
        await emit(2);
      }),
    ),
  ).toEqual([1, 2]);

  await expect(
    collect(
      streamValues(async () => {
        throw new Error("failure");
      }),
    ),
  ).rejects.toThrow("failure");

  await expect(collect(streamValues(async () => {}, AbortSignal.abort()))).rejects.toThrow(
    "cancel",
  );

  const controller = new AbortController();

  const pending = collect(
    streamValues(
      async (_, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
      controller.signal,
    ),
  );

  await new Promise((r) => setTimeout(r, 1));
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
});

it("combines JSON and streamed listing through the same authenticated client", async () => {
  const calls: RequestInit[] = [];
  let text = `event:file\ndata:${JSON.stringify([file])}\n\nevent:list\ndata:${JSON.stringify(directory)}\n\n`;

  const transport = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(init!);

    return response(text, 7);
  });

  const files = new Files(client(transport));

  expect((await files.list("cloudreve://my", { page_size: 50 })).files[0]!.name).toBe("中文");
  expect(new Headers(calls[0]!.headers).get("Accept")).toBe("text/event-stream");
  expect(new Headers(calls[0]!.headers).get("Authorization")).toBe("Bearer a");

  transport.mockImplementation(async () =>
    Response.json({ code: 0, data: { ...directory, files: [file] } }),
  );

  expect((await files.list("cloudreve://my")).files).toHaveLength(1);
  transport.mockImplementation(async () => response(text));

  for (const invalid of [
    "event:file\ndata:[]\n\n",
    `event:list\ndata:${JSON.stringify(directory)}\n\nevent:list\ndata:${JSON.stringify(directory)}\n\n`,
    `event:list\ndata:${JSON.stringify(directory)}\n\nevent:file\ndata:[]\n\n`,
    "event:file\ndata:{}\n\n",
    "event:other\ndata:{}\n\n",
    "event:list\ndata:bad\n\n",
  ]) {
    text = invalid;
    await expect(collect(files.listStream("cloudreve://my"))).rejects.toThrow();
  }
});

it("handles event UUID identity, lifecycle frames, API denials and lifetime cancellation", async () => {
  const cancel = vi.fn();

  let text =
    'event:subscribed\ndata:<nil>\n\nevent:resumed\ndata:<nil>\n\nevent:keep-alive\ndata:<nil>\n\nevent:event\ndata:{"type":"created"}\n\n';

  const transport = vi.fn(async () => response(text, 5, cancel));

  const session = client(transport);
  const files = new Files(session);
  const id = "00000000-0000-4000-8000-000000000000";

  expect((await collect(files.events("cloudreve://my", id))).map((e) => e.type)).toEqual([
    "subscribed",
    "resumed",
    "keep-alive",
    "event",
  ]);

  expect(() => files.events("cloudreve://my", "bad")).toThrow("UUID");
  text = "event:bad\ndata:null\n\n";
  await expect(collect(files.events("cloudreve://my", id))).rejects.toThrow("Unexpected");
  transport.mockImplementation(async () => Response.json({ code: 40003, msg: "feature disabled" }));
  await expect(collect(files.events("cloudreve://my", id))).rejects.toThrow("feature disabled");
  transport.mockImplementation(async () => Response.json({ code: 0, data: {} }));
  await expect(collect(files.events("cloudreve://my", id))).rejects.toThrow("Expected");

  const never = vi.fn(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );

  const other = client(never);
  const pending = collect(new Files(other).events("cloudreve://my", id));

  await new Promise((r) => setTimeout(r, 2));
  other.invalidate();
  await expect(pending).rejects.toMatchObject({ kind: "authentication" });
  expect(cancel).toHaveBeenCalled();

  const timed = collect(new Files(client(never)).events("cloudreve://my", id, { timeoutMs: 2 }));

  await expect(timed).rejects.toThrow("timed out");
});

it("refreshes a JSON auth failure before streaming but does not replay after SSE consumption", async () => {
  let count = 0;

  const transport = vi.fn(async (url: string) => {
    if (url.endsWith("token/refresh")) {
      return Response.json({
        code: 0,
        data: {
          access_token: "b",
          refresh_token: "q",
          access_expires: "2099-01-01",
          refresh_expires: "2099-02-01",
        },
      });
    }

    if (count++ === 0) {
      return Response.json({ code: 40020, msg: "expired" });
    }

    return Response.json({ code: 0, data: directory });
  });

  expect((await new Files(client(transport)).list("cloudreve://my")).files).toEqual([]);
  expect(count).toBe(2);

  const single = vi.fn(async () => response(""));

  await expect(
    client(single).consume("/api/v4/file", async () => {
      throw new ApiError(40020, "late");
    }),
  ).rejects.toThrow("late");

  expect(single).toHaveBeenCalledTimes(1);
});

it("normalizes invalid event encoding and transport interruption", async () => {
  const broken = new Response(
    new ReadableStream({
      pull(c) {
        c.error(new Error("socket failure"));
      },
    }),
  );

  await expect(collect(readSSE(broken, new AbortController().signal))).rejects.toMatchObject({
    kind: "transport",
  });

  const encoded = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(Uint8Array.of(0xff));
        c.close();
      },
    }),
  );

  await expect(collect(readSSE(encoded, new AbortController().signal))).rejects.toMatchObject({
    kind: "validation",
  });
});

it("releases a paused consumer's transport when the total deadline expires", async () => {
  const cancel = vi.fn();

  const transport = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("event:subscribed\ndata:<nil>\n\n"));
        },
        cancel,
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );

  const iter = new Files(client(transport)).events(
    "cloudreve://my",
    "00000000-0000-4000-8000-000000000000",
    { timeoutMs: 10 },
  );

  expect((await iter.next()).value?.type).toBe("subscribed");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  await expect(iter.next()).rejects.toMatchObject({ kind: "timeout" });
});

it("preserves falsy producer failures and accepts bounded large frames", async () => {
  for (const value of [undefined, null, 0, false]) {
    await expect(
      collect(
        streamValues(async () => {
          throw value;
        }),
      ),
    ).rejects.toBe(value);
  }

  const data = "x".repeat(2 * 1024 * 1024);

  const frames = await collect(
    readSSE(response(`data:${data}\n\n`, 4 * 1024 * 1024), new AbortController().signal),
  );

  expect(frames[0]!.data.length).toBe(data.length);
});
