import { resolveIntent, type IntentTree } from "./tree.js";
import { intentsPath, statusField, type IntentApi } from "./types.js";

export const SENTENCE_BATCH_SIZE = 50;
export const MAX_SENTENCES_PER_INTENT = 200;
export const MAX_EXISTING_PAGES = 20;
const PAGE_LIMIT = 100;
const DEFAULT_DEADLINE_MS = 60000;

export type ImportMode = "add" | "replace";

/** `intent` is an id, a name or a "Parent/Child" path (see resolveIntent). */
export interface ImportEntry {
  intent: string;
  sentences: string[];
}

export interface ImportOptions {
  mode: ImportMode;
  deadlineMs?: number;
  now?: () => number;
}

interface IntentOutcome {
  intent: string;
  id: string;
  created: number;
  deleted: number;
  skippedExisting: number;
  status: "ok" | "failed" | "incomplete" | "not_attempted";
  httpStatus?: number;
}

export type ImportResult =
  | {
      ok: false;
      error: "unresolved_intents";
      problems: Array<{
        intent: string;
        error: "not_found" | "ambiguous";
        candidates?: string[];
      }>;
    }
  | {
      ok: false;
      error: "empty_replace";
      problems: Array<{ intent: string; id: string }>;
    }
  | {
      ok: false;
      error: "sentence_cap_exceeded";
      problems: Array<{
        intent: string;
        id: string;
        wouldHave: number;
        cap: 200;
      }>;
    }
  | {
      ok: true;
      mode: ImportMode;
      status: "complete" | "partial";
      totals: {
        created: number;
        deleted: number;
        skippedExisting: number;
        duplicatesDropped: number;
        batches: number;
      };
      intents: IntentOutcome[];
    };

type Operation =
  | { op: "create"; value: { text: string } }
  | { op: "delete"; id: string };

interface Target {
  id: string;
  name: string;
  sentences: string[];
  duplicatesDropped: number;
  existing: Array<{ id: string; text: string }>;
  operations: Operation[];
  outcome: IntentOutcome;
}

const sentencesPath = (flowId: string, intentId: string): string =>
  `${intentsPath(flowId)}/${intentId}/sentences`;

/** Distinct trimmed non-empty sentences (first kept) and the repeats dropped. */
function dedupe(sentences: string[]): { kept: string[]; dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of sentences) {
    const text = raw.trim();
    if (text === "") continue;
    if (seen.has(text)) dropped += 1;
    else seen.add(text);
  }
  return { kept: [...seen], dropped };
}

/**
 * Reads an intent's sentences (trimmed, platform order), following the cursor
 * for at most MAX_EXISTING_PAGES pages. `truncated` is true when a cursor was
 * still present after the last page or the same cursor came back twice.
 * Rejections propagate to the caller.
 */
export async function readSentencePages(
  api: IntentApi,
  flowId: string,
  intentId: string,
): Promise<{
  sentences: Array<{ id: string; text: string }>;
  truncated: boolean;
}> {
  const path = sentencesPath(flowId, intentId);
  const found: Array<{ id: string; text: string }> = [];
  let cursor: string | null = null;
  for (let pageNo = 1; pageNo <= MAX_EXISTING_PAGES; pageNo++) {
    const params: Record<string, unknown> = { limit: PAGE_LIMIT };
    if (cursor) params.next = cursor;
    const page: any = await api.get(path, { params });
    for (const item of page?.items ?? []) {
      if (typeof item?.text === "string") {
        found.push({ id: String(item._id), text: item.text.trim() });
      }
    }
    const next: string | null = page?.nextCursor ?? null;
    if (!next) return { sentences: found, truncated: false };
    if (next === cursor) break; // same cursor twice in a row: no progress
    cursor = next;
  }
  return { sentences: found, truncated: true };
}

async function readExisting(
  api: IntentApi,
  flowId: string,
  intentId: string,
): Promise<Array<{ id: string; text: string }>> {
  const { sentences, truncated } = await readSentencePages(
    api,
    flowId,
    intentId,
  );
  if (truncated) throw new Error("existing_sentences_unbounded");
  return sentences;
}

const newSentences = (target: Target): string[] => {
  const present = new Set(target.existing.map((e) => e.text));
  return target.sentences.filter((s) => !present.has(s));
};

const wouldHave = (target: Target, mode: ImportMode): number =>
  mode === "replace"
    ? target.sentences.length
    : target.existing.length + newSentences(target).length;

function planOperations(target: Target, mode: ImportMode): void {
  const creates = newSentences(target);
  const wanted = new Set(target.sentences);
  const deletes =
    mode === "replace"
      ? target.existing.filter((e) => !wanted.has(e.text))
      : [];
  target.outcome.skippedExisting = target.sentences.length - creates.length;
  target.operations = [
    ...deletes.map((d): Operation => ({ op: "delete", id: d.id })),
    ...creates.map((text): Operation => ({ op: "create", value: { text } })),
  ];
}

function markFailed(outcome: IntentOutcome, err: unknown): void {
  outcome.status = "failed";
  Object.assign(outcome, statusField(err));
}

export async function importSentences(
  api: IntentApi,
  flowId: string,
  tree: IntentTree,
  entries: ImportEntry[],
  options: ImportOptions,
): Promise<ImportResult> {
  const { mode } = options;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const start = now();
  const expired = (): boolean => now() - start >= deadlineMs;

  // 1. Resolve every entry; nothing is called if any fails.
  const problems: Array<{
    intent: string;
    error: "not_found" | "ambiguous";
    candidates?: string[];
  }> = [];
  const merged = new Map<string, string[]>();
  for (const entry of entries) {
    const resolved = resolveIntent(tree, entry.intent);
    if (!resolved.ok) {
      problems.push({
        intent: entry.intent,
        error: resolved.error,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      });
    } else {
      merged.set(resolved.id, [
        ...(merged.get(resolved.id) ?? []),
        ...entry.sentences,
      ]);
    }
  }
  if (problems.length > 0) {
    return { ok: false, error: "unresolved_intents", problems };
  }

  // 2. De-duplicate new sentences per intent.
  const targets: Target[] = [...merged].map(([id, sentences]) => {
    const { kept, dropped } = dedupe(sentences);
    const name = tree.nodes.find((n) => n.id === id)?.name ?? id;
    return {
      id,
      name,
      sentences: kept,
      duplicatesDropped: dropped,
      existing: [],
      operations: [],
      outcome: {
        intent: name,
        id,
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        status: "not_attempted",
      },
    };
  });

  if (mode === "replace") {
    const empty = targets
      .filter((t) => t.sentences.length === 0)
      .map((t) => ({ intent: t.name, id: t.id }));
    if (empty.length > 0) {
      return { ok: false, error: "empty_replace", problems: empty };
    }
  }

  let batches = 0;
  const finish = (): ImportResult => {
    const intents = targets.map((t) => t.outcome);
    const sum = (key: "created" | "deleted" | "skippedExisting"): number =>
      intents.reduce((total, i) => total + i[key], 0);
    return {
      ok: true,
      mode,
      status: intents.every((i) => i.status === "ok") ? "complete" : "partial",
      totals: {
        created: sum("created"),
        deleted: sum("deleted"),
        skippedExisting: sum("skippedExisting"),
        duplicatesDropped: targets.reduce((t, x) => t + x.duplicatesDropped, 0),
        batches,
      },
      intents,
    };
  };

  // 3. Read existing sentences (GET only) for every intent.
  const readable: Target[] = [];
  for (const target of targets) {
    if (expired()) return finish();
    try {
      target.existing = await readExisting(api, flowId, target.id);
      readable.push(target);
    } catch (err) {
      markFailed(target.outcome, err);
    }
  }

  // 4. Cap check before any PATCH.
  const overCap = readable
    .map((t) => ({ t, total: wouldHave(t, mode) }))
    .filter(
      ({ t, total }) =>
        total > MAX_SENTENCES_PER_INTENT &&
        (mode === "replace" || newSentences(t).length > 0),
    )
    .map(({ t, total }) => ({
      intent: t.name,
      id: t.id,
      wouldHave: total,
      cap: MAX_SENTENCES_PER_INTENT as 200,
    }));
  if (overCap.length > 0) {
    return { ok: false, error: "sentence_cap_exceeded", problems: overCap };
  }

  // 5-7. Plan, then write intent by intent in batches.
  for (const target of readable) planOperations(target, mode);

  for (const target of readable) {
    const { outcome, operations } = target;
    let sentAll = true;
    for (let i = 0; i < operations.length; i += SENTENCE_BATCH_SIZE) {
      if (expired()) {
        if (i > 0) outcome.status = "incomplete";
        return finish();
      }
      const batch = operations.slice(i, i + SENTENCE_BATCH_SIZE);
      try {
        await api.patch(sentencesPath(flowId, target.id), {
          operations: batch,
        });
      } catch (err) {
        markFailed(outcome, err);
        sentAll = false;
        break;
      }
      batches += 1;
      for (const op of batch) {
        if (op.op === "create") outcome.created += 1;
        else outcome.deleted += 1;
      }
    }
    if (sentAll) outcome.status = "ok";
  }
  return finish();
}
