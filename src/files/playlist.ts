import * as v from "valibot";
import { ApiError, decode } from "../protocol/index.ts";
import { CrUri } from "./uri.ts";

/** Portable ordered tracks. Account identity and persistence belong to the app. @public */
export interface Playlist {
  name: string;
  tracks: string[];
}

const playlistSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  tracks: v.array(v.string()),
});

function trackUri(value: string): string {
  try {
    const uri = new CrUri(value);
    const parsed = new URL(value);

    if (
      uri.password() ||
      parsed.search ||
      parsed.hash ||
      parsed.port ||
      uri.isRoot() ||
      (uri.id() && uri.fs() !== "share") ||
      (uri.fs() === "share" && !uri.id()) ||
      /[:@]/.test(uri.id())
    ) {
      throw Error("Invalid track target");
    }

    const path = uri.path().split("/").map(encodeURIComponent).join("/");

    return `cloudreve://${uri.id() ? encodeURIComponent(uri.id()) + "@" : ""}${uri.fs()}${path}`;
  } catch {
    throw new ApiError(
      -1,
      "Playlist tracks require credential-free Cloudreve file URIs without queries or fragments",
    );
  }
}

function tracks(values: readonly string[]): string[] {
  return decode(v.array(v.string()), values, "Invalid playlist tracks").map(trackUri);
}

/** Validate and copy a playlist, preserving the first occurrence of each canonical URI. @public */
export function validatePlaylist(value: unknown): Playlist {
  const playlist = decode(playlistSchema, value, "Invalid playlist");

  return { name: playlist.name, tracks: [...new Set(tracks(playlist.tracks))] };
}

/** Append tracks without mutating input or duplicating existing tracks. @public */
export function playlistAdd(playlist: Playlist, uris: readonly string[]): Playlist {
  const result = validatePlaylist(playlist);

  return {
    ...result,
    tracks: [...new Set([...result.tracks, ...tracks(uris)])],
  };
}

/** Removing an absent track is an idempotent no-op. @public */
export function playlistRemove(playlist: Playlist, uris: readonly string[]): Playlist {
  const result = validatePlaylist(playlist);
  const removed = new Set(tracks(uris));

  return {
    ...result,
    tracks: result.tracks.filter((uri) => !removed.has(uri)),
  };
}

/** Move a track between zero-based positions in the validated, deduplicated order. @public */
export function playlistMove(playlist: Playlist, from: number, to: number): Playlist {
  const result = validatePlaylist(playlist);

  if (
    ![from, to].every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < result.tracks.length,
    )
  ) {
    throw new ApiError(-1, "Playlist position is out of range");
  }

  const [track] = result.tracks.splice(from, 1);

  result.tracks.splice(to, 0, track!);

  return result;
}
