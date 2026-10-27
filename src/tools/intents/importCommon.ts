import { FileAccessError, readTextFile } from "../../utils/fileAccess.js";
import { withHints } from "../filters.js";
import { parseIntentCsv, type CsvRow } from "./csv.js";
import { readFlowIntents, type FlowIntents } from "./reader.js";
import {
  importSentences,
  type ImportEntry,
  type ImportMode,
} from "./sentences.js";
import { buildTree, type IntentInput, type IntentTree } from "./tree.js";
import { intentsPath, type IntentApi } from "./types.js";

/** Shared steps of the file-based imports (import_csv, import_tree). */

export type Out = Record<string, any>;
export const MAX_NAMES_SHOWN = 20;
export const DEFAULT_IMPORT_DEADLINE_SECONDS = 120;

export interface FileImportDeps {
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}

export const firstNames = (names: string[]): string[] =>
  names.slice(0, MAX_NAMES_SHOWN);

/** Sets `key` only when the list is not empty. */
export const namesEntry = (
  key: string,
  names: string[],
): Record<string, string[]> =>
  names.length > 0 ? { [key]: firstNames(names) } : {};

/** Object holding only the numeric entries above zero, or an empty object. */
export const positive = (
  counts: Record<string, number>,
): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

export const nonEmpty = (o: Record<string, unknown>): boolean =>
  Object.keys(o).length > 0;

export function makeClock(deps: FileImportDeps, deadlineSeconds?: number) {
  const now = deps.now ?? Date.now;
  const start = now();
  const deadlineMs =
    (deadlineSeconds ?? DEFAULT_IMPORT_DEADLINE_SECONDS) * 1000;
  return {
    now,
    expired: (): boolean => now() - start >= deadlineMs,
    remainingMs: (): number => Math.max(0, deadlineMs - (now() - start)),
  };
}

type Loaded<T> = { value: T } | { refusal: Out };

/** Reads a file; a FileAccessError becomes the documented refusal. */
export async function loadText(
  deps: FileImportDeps,
  path: string,
  base: Out,
  which: "file" | "specFile" | "sentencesFile",
): Promise<Loaded<string>> {
  const read = deps.readFile ?? ((p: string) => readTextFile(p));
  try {
    return { value: await read(path) };
  } catch (err) {
    if (err instanceof FileAccessError) {
      return {
        refusal: {
          ...base,
          error: "file_error",
          which,
          code: err.code,
          message: err.message,
        },
      };
    }
    throw err;
  }
}

/** Reads and validates a sentence CSV: any bad row or no rows refuses. */
export async function loadCsv(
  deps: FileImportDeps,
  path: string,
  base: Out,
  which: "file" | "sentencesFile",
): Promise<Loaded<CsvRow[]>> {
  const text = await loadText(deps, path, base, which);
  if ("refusal" in text) return text;
  const parsed = parseIntentCsv(text.value);
  if (parsed.errors.length > 0) {
    return {
      refusal: {
        ...base,
        error: "csv_errors",
        which,
        count: parsed.errors.length,
        first: parsed.errors.slice(0, MAX_NAMES_SHOWN),
      },
    };
  }
  if (parsed.rows.length === 0) {
    return { refusal: { ...base, error: "empty_file", which } };
  }
  return { value: parsed.rows };
}

/** One list read of the tree; refuses an unreadable, truncated or broken one. */
export async function readTreeOnce(
  api: IntentApi,
  base: Out,
): Promise<Loaded<FlowIntents>> {
  const read = await readFlowIntents(api, base.flowId, {
    includeSentenceCounts: false,
  });
  if (!read.ok) {
    return {
      refusal: {
        ...base,
        error: "flow_not_readable",
        ...(read.httpStatus !== undefined
          ? { httpStatus: read.httpStatus }
          : {}),
      },
    };
  }
  if (read.truncated || read.problems.length > 0) {
    return { refusal: { ...base, error: "tree_incomplete" } };
  }
  return { value: read };
}

/** Rows grouped by intent name (file order) with their distinct sentences. */
export interface RowGroup {
  name: string;
  rows: number;
  sentences: string[];
}

export function groupRows(rows: CsvRow[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const group = groups.get(row.intent) ?? {
      name: row.intent,
      rows: 0,
      sentences: [],
    };
    group.rows += 1;
    group.sentences.push(row.sentence);
    groups.set(row.intent, group);
  }
  return [...groups.values()];
}

export const distinctCount = (sentences: string[]): number =>
  new Set(sentences.map((s) => s.trim())).size;

/** Creates one intent; the new id, or null when rejected or without an id. */
export async function createIntent(
  api: IntentApi,
  flowId: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res: unknown = await api.post(intentsPath(flowId), body);
    const id =
      typeof res === "object" && res !== null
        ? (res as { _id?: unknown })._id
        : undefined;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

export const growTree = (tree: IntentTree, added: IntentInput[]): IntentTree =>
  added.length === 0 ? tree : buildTree([...tree.nodes, ...added]);

export interface SentenceRun {
  totals: {
    created: number;
    deleted: number;
    skippedExisting: number;
    duplicatesDropped: number;
    batches: number;
  };
  failed: string[];
  incomplete: string[];
  notAttempted: string[];
  capExceeded: string[];
}

const ZERO_TOTALS = {
  created: 0,
  deleted: 0,
  skippedExisting: 0,
  duplicatesDropped: 0,
  batches: 0,
};

export const EMPTY_RUN: SentenceRun = {
  totals: ZERO_TOTALS,
  failed: [],
  incomplete: [],
  notAttempted: [],
  capExceeded: [],
};

/**
 * One importSentences call for all entries. An existing intent that would end
 * above the cap is dropped (and reported), then the rest is retried once.
 */
export async function runSentenceImport(
  api: IntentApi,
  flowId: string,
  tree: IntentTree,
  entries: ImportEntry[],
  mode: ImportMode,
  clock: { remainingMs: () => number; now: () => number },
): Promise<{ run: SentenceRun } | { error: string }> {
  if (entries.length === 0) return { run: EMPTY_RUN };
  const options = () => ({
    mode,
    deadlineMs: clock.remainingMs(),
    now: clock.now,
  });
  let result = await importSentences(api, flowId, tree, entries, options());
  const capExceeded: string[] = [];
  if (!result.ok && result.error === "sentence_cap_exceeded") {
    const over = new Set(result.problems.map((p) => p.id));
    capExceeded.push(...result.problems.map((p) => p.intent));
    const rest = entries.filter((e) => !over.has(e.intent));
    if (rest.length === 0) return { run: { ...EMPTY_RUN, capExceeded } };
    result = await importSentences(api, flowId, tree, rest, options());
  }
  if (!result.ok) return { error: result.error };
  const named = (status: string): string[] =>
    result.intents.filter((i) => i.status === status).map((i) => i.intent);
  return {
    run: {
      totals: result.totals,
      failed: named("failed"),
      incomplete: named("incomplete"),
      notAttempted: named("not_attempted"),
      capExceeded,
    },
  };
}

/** Adds the partial warning and repeat-safe action to an out object. */
export function finishResult(out: Out, partial: boolean): Out {
  out.status = partial ? "partial" : "complete";
  return partial
    ? withHints(out, {
        warning:
          "The import is partial: some intents failed, are incomplete or were not attempted.",
        action:
          "Check the counts and names, then run the same call again; what is already there is skipped.",
      })
    : out;
}
