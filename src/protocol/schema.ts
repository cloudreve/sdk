import * as v from "valibot";
import { ApiError } from "./execution.ts";

/** @public */
export const nonempty = v.pipe(v.string(), v.nonEmpty());

/** @public */
export const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** @public */
export const finite = v.pipe(v.number(), v.finite());

/** @public */
export function decode<S extends v.GenericSchema>(
  schema: S,
  value: unknown,
  message = "Invalid server response",
): v.InferOutput<S> {
  const result = v.safeParse(schema, value);

  if (!result.success) {
    throw new ApiError(-1, message);
  }

  return result.output;
}

/** @public */
export const EnvelopeSchema = v.looseObject({
  code: v.number(),
  data: v.optional(v.unknown()),
  msg: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
  correlation_id: v.optional(v.string()),
  aggregated_error: v.optional(v.unknown()),
});
