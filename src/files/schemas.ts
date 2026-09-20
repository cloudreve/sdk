import { ExplorerViewResponseSchema } from "./view.ts";
import * as v from "valibot";
import { decode, natural, nonempty } from "../protocol/index.ts";

const uri = v.pipe(
  nonempty,
  v.check((value) => {
    try {
      const parsed = new URL(value);

      decodeURIComponent(parsed.pathname);

      return parsed.protocol === "cloudreve:" && !!parsed.hostname;
    } catch {
      return false;
    }
  }),
);

/** @public */
export const FileSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  path: uri,
  type: v.picklist([0, 1]),
  size: natural,
  created_at: v.optional(v.string(), ""),
  updated_at: v.optional(v.string(), ""),
  metadata: v.optional(v.nullable(v.record(v.string(), v.string()))),
  capability: v.optional(v.string()),
  owned: v.optional(v.boolean()),
  shared: v.optional(v.boolean()),
  primary_entity: v.optional(v.string()),
});

/** @public */
export const PaginationSchema = v.looseObject({
  page: natural,
  page_size: natural,
  total_items: v.optional(natural),
  next_token: v.optional(v.string()),
  is_cursor: v.optional(v.boolean()),
});

/** @public */
export const DirectorySchema = v.looseObject({
  view: v.optional(ExplorerViewResponseSchema),
  files: v.nullable(v.array(FileSchema)),
  pagination: PaginationSchema,
  props: v.looseObject({
    capability: v.optional(v.string()),
    max_page_size: v.optional(natural),
    order_by_options: v.nullish(v.array(v.string()), []),
    order_direction_options: v.nullish(v.array(v.string()), []),
  }),
});

/** @public */
export function decodeFile(value: unknown) {
  return decode(FileSchema, value, "Invalid file response or file URI");
}

/** @public */
export function decodeDirectory(value: unknown) {
  return decode(DirectorySchema, value, "Invalid directory or pagination response");
}
