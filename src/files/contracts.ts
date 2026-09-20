import * as v from "valibot";
import { natural, nonempty } from "../protocol/index.ts";
import { FileSchema } from "./schemas.ts";

export { ExplorerViewSchema, ExplorerViewResponseSchema, type ExplorerView } from "./view.ts";

/** @public */
export const FullTextResultsSchema = v.looseObject({
  hits: v.nullish(v.array(v.looseObject({ file: FileSchema, content: v.string() })), []),
  total: natural,
});

/** @public */
export type FullTextResults = v.InferOutput<typeof FullTextResultsSchema>;

/** @public */
export const ViewerRequestSchema = v.object({
  uri: nonempty,
  viewer_id: nonempty,
  preferred_action: v.picklist(["view", "edit"]),
  version: v.optional(nonempty),
});

/** @public */
export type ViewerRequest = v.InferInput<typeof ViewerRequestSchema>;

/** @public */
export const ViewerSessionSchema = v.looseObject({
  session: v.looseObject({
    id: nonempty,
    access_token: nonempty,
    expires: natural,
  }),
  wopi_src: v.optional(v.string()),
});

/** @public */
export type ViewerSession = v.InferOutput<typeof ViewerSessionSchema>;

/** @public */
export const ViewerSchema = v.looseObject({
  id: nonempty,
  type: v.picklist(["builtin", "wopi", "custom"]),
  display_name: v.string(),
  exts: v.nullish(v.array(v.string()), []),
  url: v.optional(v.string()),
  icon: v.optional(v.string()),
  props: v.optional(v.record(v.string(), v.string())),
  max_size: v.optional(natural),
  disabled: v.optional(v.boolean()),
  platform: v.optional(v.string()),
});

/** @public */
export type Viewer = v.InferOutput<typeof ViewerSchema>;

/** @public */
export const ViewerGroupsSchema = v.nullish(
  v.array(v.object({ viewers: v.nullish(v.array(ViewerSchema), []) })),
  [],
);
