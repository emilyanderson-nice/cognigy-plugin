import { z } from "zod";
import type { manageIntentsSchema } from "../../schemas/tools.js";
import { withHints } from "../filters.js";
import { readFlowIntents, type FlowIntents } from "./reader.js";
import { resolveIntent, type IntentNode, type IntentTree } from "./tree.js";
import { statusField, type IntentApi } from "./types.js";

/** Shared helpers for manage.ts (reads) and manageWrite.ts (writes). */

export type Args = z.infer<typeof manageIntentsSchema>;
export type Op<K extends Args["operation"]> = Extract<Args, { operation: K }>;
export type Result = Record<string, unknown>;

export interface ManageDeps {
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const REQUEST_FAILED_ACTION =
  "The platform rejected or could not complete the request. Check the ids and your access, then retry.";
export const INCOMPLETE_COUNTS_WARNING =
  "Some sentence counts could not be read in time or at all; results exclude them.";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export const failure = (
  operation: string,
  error: string,
  extra: Result = {},
): Result => ({ operation, error, ...extra });

export const requestFailed = (
  operation: string,
  err: unknown,
  action: string = REQUEST_FAILED_ACTION,
): Result =>
  withHints(failure(operation, "request_failed", statusField(err)), {
    action,
  });

/** A tree read for an operation, or the error result to return instead. */
export async function readTree(
  api: IntentApi,
  operation: string,
  flowId: string,
  opts: { counts: boolean; status?: boolean; childFeatures?: boolean },
): Promise<{ read: FlowIntents } | { error: Result }> {
  const read = await readFlowIntents(api, flowId, {
    includeSentenceCounts: opts.counts,
    includeChildFeatures: opts.childFeatures === true,
    includeStatus: opts.status === true,
  });
  if (!read.ok) {
    return {
      error: failure(operation, "flow_not_readable", {
        ...(read.httpStatus !== undefined
          ? { httpStatus: read.httpStatus }
          : {}),
      }),
    };
  }
  return { read };
}

/** Tree read for a write: refuses a partial or inconsistent tree. */
export async function readTreeForWrite(
  api: IntentApi,
  operation: string,
  flowId: string,
): Promise<{ read: FlowIntents } | { error: Result }> {
  const got = await readTree(api, operation, flowId, { counts: false });
  if ("error" in got) return got;
  if (got.read.truncated || got.read.problems.length > 0) {
    return { error: failure(operation, "tree_incomplete") };
  }
  return got;
}

export type Resolved = { node: IntentNode } | { error: Result };

export function resolveNode(
  tree: IntentTree,
  operation: string,
  ref: string,
  notFoundCode: "not_found" | "parent_not_found",
): Resolved {
  const r = resolveIntent(tree, ref);
  if (!r.ok) {
    return {
      error: failure(
        operation,
        r.error === "ambiguous" ? "ambiguous" : notFoundCode,
        r.candidates ? { candidates: r.candidates } : {},
      ),
    };
  }
  const node = tree.nodes.find((n) => n.id === r.id);
  return node ? { node } : { error: failure(operation, notFoundCode) };
}
