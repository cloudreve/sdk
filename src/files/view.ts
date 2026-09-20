import * as v from "valibot";
import { natural } from "../protocol/index.ts";

/** @public */
export const ExplorerViewSchema = v.object({
  page_size: v.pipe(natural, v.minValue(50)),
  order: v.optional(v.string()),
  order_direction: v.optional(v.picklist(["asc", "desc"]), "asc"),
  view: v.optional(v.picklist(["list", "grid", "gallery"]), "list"),
  thumbnail: v.optional(v.boolean()),
  gallery_width: v.optional(v.pipe(natural, v.minValue(50), v.maxValue(500)), 200),
  columns: v.optional(
    v.array(
      v.object({
        type: natural,
        width: v.optional(natural),
        props: v.optional(
          v.object({
            metadata_key: v.optional(v.string()),
            custom_props_id: v.optional(v.string()),
          }),
        ),
      }),
    ),
  ),
});

/** @public */
export type ExplorerView = v.InferInput<typeof ExplorerViewSchema>;

/** Effective response view can reflect small listing page sizes and inherited zero values. @public */
export const ExplorerViewResponseSchema = v.looseObject({
  ...ExplorerViewSchema.entries,
  page_size: natural,
  order_direction: v.optional(v.picklist(["asc", "desc"])),
  view: v.optional(v.picklist(["list", "grid", "gallery"])),
  gallery_width: v.optional(natural),
});
