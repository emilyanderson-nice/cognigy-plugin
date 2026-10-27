import { manageIntentsSchema } from "../../schemas/tools.js";
import { FileAccessError, readTextFile } from "../../utils/fileAccess.js";
import { withHints } from "../filters.js";
import { modelState } from "./build.js";
import { belowMinimum, compareIntents, parseIntentCsv } from "./csv.js";
import {
  failure,
  INCOMPLETE_COUNTS_WARNING,
  readTree,
  requestFailed,
  type ManageDeps,
  type Op,
  type Result,
} from "./manageCommon.js";
import {
  build,
  create,
  importOp,
  move,
  remove,
  update,
} from "./manageWrite.js";
import { exportTree, getIntent, readFlowIntents } from "./reader.js";
import type { IntentApi } from "./types.js";

export type { ManageDeps } from "./manageCommon.js";

const MAX_PARSE_ERRORS_SHOWN = 20;

const namesOf = (names: string[]): { uncountedIntents?: string[] } =>
  names.length > 0 ? { uncountedIntents: names } : {};

// ---------------------------------------------------------------- reads

async function list(api: IntentApi, a: Op<"list">): Promise<Result> {
  const read = await readFlowIntents(api, a.flowId, {
    includeSentenceCounts: a.includeSentenceCounts !== false,
    includeChildFeatures: true,
    includeStatus: a.includeStatus === true,
  });
  if (!read.ok) {
    return failure(a.operation, "flow_not_readable", {
      ...(read.httpStatus !== undefined ? { httpStatus: read.httpStatus } : {}),
    });
  }
  const result: Result = {
    operation: a.operation,
    flowId: a.flowId,
    total: read.total,
    maxDepth: read.maxDepth,
    intents: read.intents,
    ...(read.truncated ? { truncated: true } : {}),
    ...(read.countsIncomplete ? { countsIncomplete: true } : {}),
    ...(read.problems.length > 0 ? { problems: read.problems } : {}),
  };
  if (read.truncated || read.countsIncomplete || read.problems.length > 0) {
    return withHints(result, {
      warning:
        "The list is incomplete: it was cut short, has unreadable counts or details, or the hierarchy has orphaned or cyclic intents. Do not treat it as the full picture.",
    });
  }
  return result;
}

async function get(api: IntentApi, a: Op<"get">): Promise<Result> {
  const got = await readTree(api, a.operation, a.flowId, { counts: false });
  if ("error" in got) return got.error;
  const r = await getIntent(api, a.flowId, got.read.tree, a.intent, {
    includeSentences: a.includeSentences,
  });
  if (!r.ok) {
    if (r.error === "not_found" && got.read.truncated) {
      return failure(a.operation, "tree_incomplete");
    }
    return failure(a.operation, r.error, {
      ...(r.candidates ? { candidates: r.candidates } : {}),
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
    });
  }
  return {
    operation: a.operation,
    flowId: a.flowId,
    intent: r.intent,
    ...(r.sentences ? { sentences: r.sentences } : {}),
    ...(r.sentencesTruncated ? { sentencesTruncated: true } : {}),
  };
}

async function exportTreeOp(
  api: IntentApi,
  a: Op<"export_tree">,
): Promise<Result> {
  const got = await readTree(api, a.operation, a.flowId, {
    counts: true,
    childFeatures: true,
  });
  if ("error" in got) return got.error;
  return { operation: a.operation, ...exportTree(a.flowId, got.read) };
}

async function belowMinimumOp(
  api: IntentApi,
  a: Op<"below_minimum">,
): Promise<Result> {
  const got = await readTree(api, a.operation, a.flowId, {
    counts: true,
    childFeatures: true,
  });
  if ("error" in got) return got.error;
  // Inheriting parents train on their children's sentences too.
  const counted = got.read.intents.flatMap((i) => {
    const used = i.effectiveSentenceCount ?? i.sentenceCount;
    return used === undefined
      ? []
      : [
          {
            name: i.name,
            id: i.id,
            sentenceCount: used,
            ...(i.effectiveSentenceCount !== undefined &&
            i.sentenceCount !== undefined
              ? { ownSentenceCount: i.sentenceCount }
              : {}),
          },
        ];
  });
  const uncounted = got.read.intents
    .filter((i) => i.sentenceCount === undefined)
    .map((i) => i.name);
  const incomplete = got.read.countsIncomplete === true || uncounted.length > 0;
  const result: Result = {
    operation: a.operation,
    flowId: a.flowId,
    ...belowMinimum(counted, a.min),
    ...namesOf(uncounted),
    ...(incomplete ? { countsIncomplete: true } : {}),
  };
  return incomplete
    ? withHints(result, { warning: INCOMPLETE_COUNTS_WARNING })
    : result;
}

async function compare(
  api: IntentApi,
  a: Op<"compare">,
  deps: ManageDeps,
): Promise<Result> {
  const readFile = deps.readFile ?? ((p: string) => readTextFile(p));
  let text: string;
  try {
    text = await readFile(a.file);
  } catch (err) {
    if (err instanceof FileAccessError) {
      return failure(a.operation, "file_error", {
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }
  const parsed = parseIntentCsv(text);
  const got = await readTree(api, a.operation, a.flowId, { counts: true });
  if ("error" in got) return got.error;
  const flow = got.read.intents.flatMap((i) =>
    i.sentenceCount === undefined
      ? []
      : [{ name: i.name, sentenceCount: i.sentenceCount }],
  );
  const uncounted = got.read.intents
    .filter((i) => i.sentenceCount === undefined)
    .map((i) => i.name);
  // Unmeasured intents exist; they must not be reported as missing.
  const unmeasured = new Set(uncounted.map((n) => n.trim()));
  const report = compareIntents(flow, parsed.rows);
  report.missing = report.missing.filter((n) => !unmeasured.has(n));
  const incomplete = got.read.countsIncomplete === true || uncounted.length > 0;
  const result: Result = {
    operation: a.operation,
    flowId: a.flowId,
    file: a.file,
    rows: parsed.rows.length,
    parseErrors: {
      count: parsed.errors.length,
      first: parsed.errors.slice(0, MAX_PARSE_ERRORS_SHOWN),
    },
    report,
    ...namesOf(uncounted),
    ...(incomplete ? { countsIncomplete: true } : {}),
  };
  return incomplete
    ? withHints(result, { warning: INCOMPLETE_COUNTS_WARNING })
    : result;
}

async function modelStateOp(
  api: IntentApi,
  a: Op<"model_state">,
): Promise<Result> {
  return { operation: a.operation, ...(await modelState(api, a.flowId)) };
}

// -------------------------------------------------------------- entry

export async function handleManageIntents(
  api: IntentApi,
  args: unknown,
  deps: ManageDeps = {},
): Promise<any> {
  const a = manageIntentsSchema.parse(args);
  try {
    switch (a.operation) {
      case "list":
        return await list(api, a);
      case "get":
        return await get(api, a);
      case "export_tree":
        return await exportTreeOp(api, a);
      case "below_minimum":
        return await belowMinimumOp(api, a);
      case "compare":
        return await compare(api, a, deps);
      case "model_state":
        return await modelStateOp(api, a);
      case "create":
        return await create(api, a);
      case "update":
        return await update(api, a);
      case "move":
        return await move(api, a);
      case "delete":
        return await remove(api, a);
      case "import_sentences":
        return await importOp(api, a, deps);
      case "build":
        return await build(api, a, deps);
    }
  } catch (err) {
    return requestFailed(a.operation, err);
  }
}
