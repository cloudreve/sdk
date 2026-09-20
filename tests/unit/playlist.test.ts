import { expect, it } from "vitest";
import fc from "fast-check";
import { ApiError } from "../../src/protocol/index.ts";
import {
  validatePlaylist,
  playlistAdd,
  playlistRemove,
  playlistMove,
} from "../../src/files/playlist.ts";

const a = "cloudreve://my/a.mp3";
const b = "cloudreve://my/b.mp3";
const c = "cloudreve://my/c.mp3";

it("normalizes names and URI spelling without storing credentials or duplicate tracks", () => {
  const input = {
    name: "  Evening  ",
    tracks: [
      a,
      "cloudreve://MY/%61.mp3",
      "cloudreve://id@share/a%20b.mp3",
      "cloudreve://my/目录/音 乐.flac",
    ],
  };

  const result = validatePlaylist(input);

  expect(result).toEqual({
    name: "Evening",
    tracks: [
      a,
      "cloudreve://id@share/a%20b.mp3",
      "cloudreve://my/%E7%9B%AE%E5%BD%95/%E9%9F%B3%20%E4%B9%90.flac",
    ],
  });

  expect(input.name).toBe("  Evening  ");
  expect(input.tracks).toHaveLength(4);

  expect(validatePlaylist({ name: "Empty", tracks: [] })).toEqual({
    name: "Empty",
    tracks: [],
  });
});

it("rejects malformed, signed and password-bearing track targets without echoing secrets", () => {
  for (const uri of [
    "https://example.test/a?token=secret",
    "cloudreve://id:secret@share/a.mp3",
    "cloudreve://my/a?token=secret",
    "cloudreve://my/a#secret",
    "cloudreve://my:80/a",
    "cloudreve://my/",
    "cloudreve://id@my/a",
    "cloudreve://share/a",
    "cloudreve://id%3Asecret@share/a",
    "cloudreve://id%40secret@share/a",
    "cloudreve://my/%ZZ",
  ]) {
    expect(() => validatePlaylist({ name: "x", tracks: [uri] })).toThrow(ApiError);

    try {
      validatePlaylist({ name: "x", tracks: [uri] });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }

  for (const invalid of [
    null,
    {},
    { name: " ", tracks: [] },
    { name: "x", tracks: "a" },
    { name: "x", tracks: [1] },
    { name: "x", tracks: [], token: "secret" },
  ]) {
    expect(() => validatePlaylist(invalid)).toThrow(ApiError);
  }

  expect(() => playlistAdd({ name: "x", tracks: [] }, null as unknown as string[])).toThrow(
    ApiError,
  );
});

it("adds, removes and moves in stable order while leaving the original untouched", () => {
  const original = { name: "Mix", tracks: [a, b, c] };

  expect(playlistAdd(original, [b, "cloudreve://my/%61.mp3"])).toEqual(original);
  expect(playlistAdd({ name: "Mix", tracks: [a] }, [b, c, b]).tracks).toEqual([a, b, c]);

  expect(
    playlistRemove(original, ["cloudreve://my/%62.mp3", "cloudreve://my/absent.mp3"]).tracks,
  ).toEqual([a, c]);

  expect(playlistMove(original, 0, 2).tracks).toEqual([b, c, a]);
  expect(playlistMove(original, 2, 0).tracks).toEqual([c, a, b]);
  expect(playlistMove(original, 1, 1)).toEqual(original);
  expect(original.tracks).toEqual([a, b, c]);

  for (const [from, to] of [
    [-1, 0],
    [0, -1],
    [3, 0],
    [0, 3],
    [0.5, 0],
    [0, NaN],
    [Infinity, 0],
  ]) {
    expect(() => playlistMove(original, from!, to!)).toThrow(ApiError);
  }

  expect(() => playlistMove({ name: "Empty", tracks: [] }, 0, 0)).toThrow(ApiError);
});

it("preserves set/order invariants across arbitrary track collections", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 50 })), (values) => {
      const original = {
        name: "Generated",
        tracks: values.map((i) => `cloudreve://my/${i}.mp3`),
      };

      const expected = [...new Set(original.tracks)];

      expect(validatePlaylist(validatePlaylist(original))).toEqual({
        name: "Generated",
        tracks: expected,
      });

      expect(playlistAdd(original, original.tracks).tracks).toEqual(expected);
      expect(playlistRemove(original, original.tracks).tracks).toEqual([]);
    }),
  );
});
