import { it, expect } from "vitest";
import { lockConflicts } from "../../src/files/index";
import { ApiError } from "../../src/protocol/index";

it("extracts typed owner details, redacted conflicts and unique tokens", () => {
  const row = {
    path: "cloudreve://my/file",
    token: "sensitive",
    type: 0,
    owner: { application: { type: "webdav", inner_xml: "<owner>app</owner>" } },
  };

  const error = new ApiError(40073, "locked", undefined, [
    row,
    row,
    { type: 1, owner: { application: { type: "upload", viewer_id: "v" } } },
    { token: 3, type: 0 },
    null,
  ]);

  expect(lockConflicts(error)).toEqual([
    row,
    { type: 1, owner: { application: { type: "upload", viewer_id: "v" } } },
  ]);
});

it("traverses actual aggregate response fields without cycles or unrelated-token guesses", () => {
  const nested = {
    code: 40081,
    aggregated_error: {
      file: { code: 40073, data: [{ path: "p", token: "t", type: 0 }] },
    },
  };

  const error = new ApiError(
    40081,
    "partial",
    undefined,
    { successful: ["a"] },
    { operation: nested },
  );

  expect(lockConflicts(error)).toEqual([{ path: "p", token: "t", type: 0 }]);

  const cycle: { code: number; data: Record<string, unknown> } = {
    code: 40081,
    data: {},
  };

  cycle.data.self = cycle;
  cycle.data.nested = nested;
  expect(lockConflicts(cycle)).toHaveLength(1);
  expect(lockConflicts({ code: 40081, data: 3 })).toEqual([]);
  expect(lockConflicts({ code: 40081 })).toEqual([]);
  expect(lockConflicts(null)).toEqual([]);
  expect(lockConflicts({ code: 403, data: [{ token: "not-a-lock", type: 0 }] })).toEqual([]);
});
