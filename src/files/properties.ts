import * as v from "valibot";
import { decode, nonempty } from "../protocol/index.ts";
import { ApiError } from "../protocol/index.ts";

/** @public */
export interface CustomProperty {
  id: string;
  name: string;
  type: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: string;
}

/** Validate the Community custom-property wire value; lengths are UTF-8 bytes. @public */
export function customPropertyPatch(
  property: CustomProperty,
  value: string,
  remove = false,
): { key: string; value?: string; remove?: boolean } {
  property = decode(
    v.object({
      id: nonempty,
      name: v.string(),
      type: nonempty,
      min: v.optional(v.number()),
      max: v.optional(v.number()),
      options: v.optional(v.array(v.string())),
      default: v.optional(v.string()),
    }),
    property,
    "Invalid custom property configuration",
  );

  const fail = () => {
    throw new ApiError(-1, "Invalid custom property value or configuration");
  };

  if (typeof value !== "string" || typeof remove !== "boolean") {
    fail();
  }

  const key = `props:${property.id}`;

  if (remove) {
    return { key, remove: true };
  }

  const min = property.min ?? 0;
  const max = property.max ?? 0;

  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    fail();
  }

  if (property.type !== "text" && value === "") {
    return { key, value };
  }

  switch (property.type) {
    case "text":
    case "link": {
      const bytes = new TextEncoder().encode(value).length;

      if ((min > 0 && bytes < min) || (max > 0 && bytes > max)) {
        fail();
      }

      break;
    }

    case "number":
    case "rating": {
      if (!/^[+-]?\d+$/.test(value)) {
        fail();
      }

      const number = BigInt(value);

      if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) {
        fail();
      }

      if (property.type === "number") {
        if (number < BigInt(min) || (max > 0 && number > BigInt(max))) {
          fail();
        }
      } else if (number > BigInt(max)) {
        fail();
      }

      break;
    }

    case "boolean":
      if (value !== "true" && value !== "false") {
        fail();
      }

      break;
    case "select":
      if (!property.options?.includes(value)) {
        fail();
      }

      break;
    case "multi_select": {
      let selected: unknown;

      try {
        selected = JSON.parse(value);
      } catch {
        fail();
      }

      if (
        selected !== null &&
        (!Array.isArray(selected) ||
          selected.some((item) => typeof item !== "string" || !property.options?.includes(item)))
      ) {
        fail();
      }

      break;
    }

    default:
      throw new ApiError(-1, "Unsupported custom property type", undefined, undefined, undefined, {
        kind: "unsupported",
      });
  }

  return { key, value };
}

/** Server metadata names; emoji values must belong to the configured presets. @public */
export const iconMetadataKeys = {
  emoji: "customize:emoji",
  color: "customize:icon_color",
} as const;

/** @public */
export const EntityType = { version: 0, thumbnail: 1, livePhoto: 2 } as const;

/** Application-neutral digest hints; trust only when independently verified against the bound entity. @public */
export const backupMetadataKeys = {
  sha256: "customize:client_sha256",
  entity: "customize:client_sha256_entity",
} as const;

/** Read-only metadata emitted by media extraction. @public */
export const mediaMetadataKeys = {
  title: "music:title",
  artist: "music:artist",
  album: "music:album",
  duration: "stream:duration",
} as const;
