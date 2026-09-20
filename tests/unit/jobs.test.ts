import { it, expect, vi } from "vitest";
import {
  Jobs,
  TaskType,
  TaskStatus,
  ListTaskCategory,
  canSelectTaskFiles,
} from "@cloudreve/sdk/jobs";
import { AccountClient } from "@cloudreve/sdk/session";

function fixture(data: unknown) {
  const transport = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ code: 0, data }),
  );

  return {
    transport,
    jobs: new Jobs(
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

const task = {
  id: "id",
  type: TaskType.remote_download,
  status: TaskStatus.processing,
  created_at: "",
  updated_at: "",
  summary: {
    phase: "monitor",
    props: {
      download: {
        name: "Test",
        state: "downloading" as never,
        total: 2,
        downloaded: 0,
        download_speed: 0,
        upload_speed: 0,
        uploaded: 0,
        files: [
          { index: 1, name: "one", size: 1, progress: 0, selected: true },
          { index: 2, name: "two", size: 1, progress: 0, selected: true },
        ],
      },
    },
  },
};

it("keeps empty task lists usable and follows tasks from active to finished", async () => {
  const f = fixture({ tasks: null, pagination: { page: 0, page_size: 50 } });

  expect((await f.jobs.list(ListTaskCategory.general)).tasks).toEqual([]);

  f.transport.mockResolvedValueOnce(
    Response.json({ code: 0, data: { tasks: [], pagination: {} } }),
  );

  f.transport.mockResolvedValueOnce(
    Response.json({
      code: 0,
      data: {
        tasks: [{ ...task, status: TaskStatus.completed }],
        pagination: {},
      },
    }),
  );

  expect((await f.jobs.get("id", TaskType.remote_download)).status).toBe(TaskStatus.completed);
  expect(f.transport.mock.lastCall?.[0]).toContain("category=downloaded");
});

it("changes file selection only for a supported active remote task", async () => {
  const f = fixture(null);

  expect(canSelectTaskFiles(task)).toBe(true);
  await f.jobs.selectFiles(task, [2]);

  expect(JSON.parse(String(f.transport.mock.lastCall?.[1]?.body))).toEqual({
    files: [
      { index: 1, download: false },
      { index: 2, download: true },
    ],
  });

  await expect(f.jobs.selectFiles(task, [])).rejects.toThrow("Select");
  await expect(f.jobs.selectFiles(task, [99])).rejects.toThrow("Select");
  await expect(f.jobs.cancel({ ...task, type: TaskType.create_archive })).rejects.toThrow("cannot");

  await expect(f.jobs.selectFiles({ ...task, status: TaskStatus.completed }, [1])).rejects.toThrow(
    "while",
  );

  await f.jobs.cancel(task);
  expect(f.transport.mock.lastCall?.[1]?.method).toBe("DELETE");
});

it("rejects invalid archive inputs and preserves exact selected archive paths", async () => {
  const f = fixture({ ...task, type: TaskType.extract_archive });

  await expect(f.jobs.archive({ src: [], dst: "cloudreve://my/" })).rejects.toThrow("Select");

  await expect(
    f.jobs.archive(
      {
        src: ["cloudreve://my/a.zip"],
        dst: "cloudreve://my/",
        file_mask: ["../escape"],
      },
      true,
    ),
  ).rejects.toThrow("Unsafe");

  await f.jobs.archive(
    {
      src: ["cloudreve://my/a.zip"],
      dst: "cloudreve://my/out",
      file_mask: ["中文.txt"],
    },
    true,
  );

  expect(f.transport.mock.lastCall?.[0]).toContain("/workflow/extract");
  expect(JSON.parse(String(f.transport.mock.lastCall?.[1]?.body)).file_mask).toEqual(["中文.txt"]);
});

it("rejects malformed archive entries and invalid source schemes", async () => {
  const f = fixture({
    files: [{ name: "bad", size: "unknown", is_directory: false }],
  });

  await expect(f.jobs.archiveFiles("cloudreve://my/a.zip")).rejects.toThrow("archive entry");

  await expect(
    f.jobs.archive({ src: ["file:///private"], dst: "cloudreve://my/a.zip" }),
  ).rejects.toThrow("location");

  f.transport.mockImplementation(async () => Response.json({ code: 0, data: { files: null } }));
  expect(await f.jobs.archiveFiles("cloudreve://my/a.zip")).toEqual([]);
});

it("does not submit password-protected ZIP extraction to a workflow that ignores its password", async () => {
  const f = fixture(null);

  await expect(
    f.jobs.archive(
      {
        src: ["cloudreve://my/protected.zip"],
        dst: "cloudreve://my/",
        password: "secret",
      },
      true,
    ),
  ).rejects.toThrow("unavailable");

  expect(f.transport).not.toHaveBeenCalled();
});

it("rejects unsupported encodings and queued cancellation without sending a mutation", async () => {
  const f = fixture(null);

  await expect(f.jobs.archiveFiles("cloudreve://my/a.zip", "unknown")).rejects.toThrow("encoding");
  await expect(f.jobs.cancel({ ...task, status: TaskStatus.queued })).rejects.toThrow("cannot");
  expect(f.transport).not.toHaveBeenCalled();
});
