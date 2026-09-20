import * as v from "valibot";

/** Tokens are secret capabilities; the owner field describes an application, not verified user authority. @public */
export interface LockConflict {
  path?: string;
  token?: string;
  type: 0 | 1;
  owner?: {
    application: { type: string; inner_xml?: string; viewer_id?: string };
  };
}

const schema = v.object({
  path: v.optional(v.string()),
  token: v.optional(v.string()),
  type: v.picklist([0, 1]),
  owner: v.optional(
    v.object({
      application: v.object({
        type: v.string(),
        inner_xml: v.optional(v.string()),
        viewer_id: v.optional(v.string()),
      }),
    }),
  ),
});

/** Extract validated lock details without logging or acting on their capability tokens. @public */
export function lockConflicts(error: unknown): LockConflict[] {
  const pending = [error];
  const visited = new Set<unknown>();
  const keys = new Set<string>();
  const result: LockConflict[] = [];

  while (pending.length) {
    const next = pending.pop();

    if (!next || typeof next !== "object" || visited.has(next)) {
      continue;
    }

    visited.add(next);

    const value = next as {
      code?: unknown;
      data?: unknown;
      aggregatedError?: unknown;
      aggregated_error?: unknown;
    };

    if (value.code === 40073 && Array.isArray(value.data)) {
      for (const item of value.data) {
        const parsed = v.safeParse(schema, item);

        if (!parsed.success) {
          continue;
        }

        const row = parsed.output;
        const key = row.token || JSON.stringify(row);

        if (!keys.has(key)) {
          keys.add(key);
          result.push(row);
        }
      }
    } else if (value.code === 40081) {
      const entries = value.aggregatedError ?? value.aggregated_error ?? value.data;

      if (entries && typeof entries === "object") {
        pending.push(...Object.values(entries));
      }
    }
  }

  return result;
}
