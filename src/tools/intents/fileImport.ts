import {
  countStatus,
  createIntent,
  distinctCount,
  EMPTY_RUN,
  finishResult,
  groupRows,
  growTree,
  loadCsv,
  loadText,
  makeClock,
  namesEntry,
  nonEmpty,
  positive,
  readTreeOnce,
  runSentenceImport,
  firstNames,
  MAX_NAMES_SHOWN,
  type FileImportDeps,
  type Out,
  type SentenceRun,
} from "./importCommon.js";
import {
  MAX_SENTENCES_PER_INTENT,
  type ImportEntry,
  type ImportMode,
} from "./sentences.js";
import {
  planTree,
  parseTreeSpec,
  pathKey,
  specPathsInOrder,
} from "./treeSpec.js";
import { resolveIntent, type IntentInput } from "./tree.js";
import type { IntentApi } from "./types.js";

export type { FileImportDeps } from "./importCommon.js";

const sentenceTotals = (rows: number, run: SentenceRun): Out => ({
  rows,
  created: run.totals.created,
  deleted: run.totals.deleted,
  skippedExisting: run.totals.skippedExisting,
  duplicatesDropped: run.totals.duplicatesDropped,
});

const notDoneOf = (run: SentenceRun, extraNotAttempted: number): Out =>
  positive({
    failed: run.failed.length,
    incomplete: run.incomplete.length,
    notAttempted: run.notAttempted.length + extraNotAttempted,
  });

// --------------------------------------------------------------- import_csv

export async function importCsv(
  api: IntentApi,
  a: {
    flowId: string;
    file: string;
    mode: "add" | "replace";
    createMissing?: boolean;
    deadlineSeconds?: number;
  },
  deps: FileImportDeps = {},
): Promise<Out> {
  const clock = makeClock(deps, a.deadlineSeconds);
  const base = { operation: "import_csv", flowId: a.flowId };

  const csv = await loadCsv(deps, a.file, base, "file");
  if ("refusal" in csv) return csv.refusal;
  const got = await readTreeOnce(api, base);
  if ("refusal" in got) return got.refusal;
  const { tree } = got.value;

  const groups = groupRows(csv.value);
  const overCap = groups.filter(
    (g) => distinctCount(g.sentences) > MAX_SENTENCES_PER_INTENT,
  );
  const kept = groups.filter((g) => !overCap.includes(g));

  const existingId = new Map<string, string>();
  const missing: string[] = [];
  const ambiguous: Array<{ intent: string; candidates: string[] }> = [];
  for (const g of kept) {
    const r = resolveIntent(tree, g.name);
    if (r.ok) existingId.set(g.name, r.id);
    else if (r.error === "ambiguous") {
      ambiguous.push({ intent: g.name, candidates: r.candidates ?? [] });
    } else missing.push(g.name);
  }
  if (ambiguous.length > 0) {
    return {
      ...base,
      error: "ambiguous_intents",
      count: ambiguous.length,
      problems: ambiguous.slice(0, 20),
    };
  }

  // Create missing intents as flat roots, in file order.
  const createdId = new Map<string, string>();
  const createFailed: string[] = [];
  const failedByStatus: Record<string, number> = {};
  let neverCreated = 0;
  if (a.createMissing !== false) {
    for (const name of missing) {
      if (clock.expired()) {
        neverCreated += 1;
        continue;
      }
      const made = await createIntent(api, a.flowId, { name });
      if ("id" in made) createdId.set(name, made.id);
      else {
        createFailed.push(name);
        countStatus(failedByStatus, made.status);
      }
    }
  }

  const added: IntentInput[] = [...createdId].map(([name, id]) => ({
    id,
    name,
    parentId: null,
  }));
  const entries: ImportEntry[] = [];
  for (const g of kept) {
    const id = existingId.get(g.name) ?? createdId.get(g.name);
    if (id !== undefined) entries.push({ intent: id, sentences: g.sentences });
  }

  const ran = await runSentenceImport(
    api,
    a.flowId,
    growTree(tree, added),
    entries,
    a.mode as ImportMode,
    clock,
  );
  if ("error" in ran) return { ...base, error: ran.error };
  const run = ran.run;

  const notDone = notDoneOf(run, neverCreated);
  const skipped = positive({
    missing: a.createMissing === false ? missing.length : 0,
    overCap: overCap.length,
    capExceeded: run.capExceeded.length,
  });
  const names = {
    ...namesEntry("createFailed", createFailed),
    ...namesEntry(
      "overCap",
      overCap.map((g) => g.name),
    ),
    ...namesEntry("capExceeded", run.capExceeded),
    ...namesEntry("missing", a.createMissing === false ? missing : []),
    ...namesEntry("failed", run.failed),
    ...namesEntry("incomplete", run.incomplete),
    ...namesEntry("notAttempted", run.notAttempted),
  };
  const out: Out = {
    ...base,
    ok: true,
    mode: a.mode,
    intents: {
      inFile: groups.length,
      existing: existingId.size,
      created: createdId.size,
      createFailed: createFailed.length,
      ...(nonEmpty(failedByStatus)
        ? { createFailedByStatus: failedByStatus }
        : {}),
    },
    sentences: sentenceTotals(csv.value.length, run),
    batches: run.totals.batches,
    ...(nonEmpty(skipped) ? { skipped } : {}),
    ...(nonEmpty(notDone) ? { notDone } : {}),
    ...(nonEmpty(names) ? { names } : {}),
  };
  return finishResult(
    out,
    createFailed.length > 0 || nonEmpty(notDone),
    failedByStatus,
  );
}

// -------------------------------------------------------------- import_tree

export async function importTree(
  api: IntentApi,
  a: {
    flowId: string;
    specFile: string;
    sentencesFile?: string;
    mode?: "add" | "replace";
    deadlineSeconds?: number;
  },
  deps: FileImportDeps = {},
): Promise<Out> {
  const clock = makeClock(deps, a.deadlineSeconds);
  const base = { operation: "import_tree", flowId: a.flowId };
  const mode: ImportMode = a.mode ?? "add";

  const specText = await loadText(deps, a.specFile, base, "specFile");
  if ("refusal" in specText) return specText.refusal;
  const parsed = parseTreeSpec(specText.value);
  if (!parsed.ok) {
    return {
      ...base,
      error: "spec_invalid",
      count: parsed.count,
      problems: parsed.problems,
    };
  }
  const { spec } = parsed;

  let rows: Array<{ intent: string; sentence: string; line: number }> = [];
  if (a.sentencesFile !== undefined) {
    const csv = await loadCsv(deps, a.sentencesFile, base, "sentencesFile");
    if ("refusal" in csv) return csv.refusal;
    rows = csv.value;
  }

  const got = await readTreeOnce(api, base);
  if ("refusal" in got) return got.refusal;
  const { tree } = got.value;
  const plan = planTree(spec, tree);

  // Names are unique across the whole flow: refuse before any write.
  const creating = new Set(plan.create.map((c) => pathKey(c.path)));
  const clashes = specPathsInOrder(spec.nodes).filter(
    ({ path }) =>
      creating.has(pathKey(path)) &&
      tree.nodes.some((n) => n.name.trim() === path[path.length - 1]),
  );
  if (clashes.length > 0) {
    return {
      ...base,
      error: "name_in_use",
      count: clashes.length,
      problems: clashes
        .slice(0, MAX_NAMES_SHOWN)
        .map(({ at }) => ({ path: at, reason: "name_in_use" })),
    };
  }

  // Ids by spec path: existing first, then each created intent.
  const idOf = new Map<string, string>(
    plan.existing.map((e) => [pathKey(e.path), e.id]),
  );
  const unusable = new Set<string>(); // failed or not attempted (path keys)
  const added: IntentInput[] = [];
  const created = { 1: 0, 2: 0, 3: 0 };
  const createFailed: string[] = [];
  const failedByStatus: Record<string, number> = {};
  let notAttempted = 0;

  for (const level of [1, 2, 3] as const) {
    for (const item of plan.create.filter((c) => c.level === level)) {
      const key = pathKey(item.path);
      const parentKey = item.parentPath ? pathKey(item.parentPath) : null;
      if (clock.expired() || (parentKey !== null && unusable.has(parentKey))) {
        unusable.add(key);
        notAttempted += 1;
        continue;
      }
      const name = item.path[item.path.length - 1];
      const parentId =
        parentKey === null ? null : (idOf.get(parentKey) ?? null);
      const made = await createIntent(api, a.flowId, {
        name,
        ...(parentId !== null ? { parentIntentId: parentId } : {}),
        ...(level < 3 ? { childFeatures: true } : {}),
      });
      if (!("id" in made)) {
        unusable.add(key);
        createFailed.push(name);
        countStatus(failedByStatus, made.status);
        continue;
      }
      idOf.set(key, made.id);
      added.push({ id: made.id, name, parentId });
      created[level] += 1;
    }
  }

  const levelCount = (level: 1 | 2 | 3): number =>
    plan.existing.filter((e) => e.level === level).length;
  const parentsNeedingChildFeatures = plan.existing
    .filter((e) => e.level < 3)
    .filter(
      (e) =>
        got.value.intents.find((i) => i.id === e.id)?.childFeatures === false,
    )
    .map((e) => e.path[e.path.length - 1]);

  // Sentences go to spec tags only, matched by tag name.
  const skipped: Record<string, number> = {};
  const names: Record<string, string[]> = {};
  let run: SentenceRun = EMPTY_RUN;
  if (a.sentencesFile !== undefined) {
    const tags = spec.nodes.filter((n) => n.level === 3);
    const tagKeys = new Map(tags.map((n) => [n.path[2], pathKey(n.path)]));
    const groups = groupRows(rows);
    const entries: ImportEntry[] = [];
    const notInSpec: string[] = [];
    let notInSpecRows = 0;
    let tagNotCreated = 0;
    const overCap: string[] = [];
    const byName = new Map(groups.map((g) => [g.name, g]));
    for (const g of groups) {
      if (!tagKeys.has(g.name)) {
        notInSpec.push(g.name);
        notInSpecRows += g.rows;
      }
    }
    for (const tag of tags) {
      const g = byName.get(tag.path[2]);
      if (!g) continue;
      const id = idOf.get(pathKey(tag.path));
      if (id === undefined || unusable.has(pathKey(tag.path))) {
        tagNotCreated += g.rows;
      } else if (distinctCount(g.sentences) > MAX_SENTENCES_PER_INTENT) {
        overCap.push(g.name);
      } else entries.push({ intent: id, sentences: g.sentences });
    }
    const ran = await runSentenceImport(
      api,
      a.flowId,
      growTree(tree, added),
      entries,
      mode,
      clock,
    );
    if ("error" in ran) return { ...base, error: ran.error };
    run = ran.run;
    Object.assign(
      skipped,
      positive({
        notInSpecRows,
        notInSpecIntents: notInSpec.length,
        tagNotCreated,
        overCap: overCap.length,
        capExceeded: run.capExceeded.length,
      }),
    );
    Object.assign(
      names,
      namesEntry("overCap", overCap),
      namesEntry("capExceeded", run.capExceeded),
      namesEntry("notInSpec", notInSpec),
    );
  }

  const notDone = notDoneOf(run, 0);
  Object.assign(
    names,
    namesEntry("createFailed", createFailed),
    namesEntry("failed", run.failed),
    namesEntry("incomplete", run.incomplete),
    namesEntry("notAttempted", run.notAttempted),
  );
  const out: Out = {
    ...base,
    ok: true,
    mode,
    intents: {
      planned: spec.counts,
      existing: {
        families: levelCount(1),
        groups: levelCount(2),
        tags: levelCount(3),
      },
      created: { families: created[1], groups: created[2], tags: created[3] },
      createFailed: createFailed.length,
      ...(nonEmpty(failedByStatus)
        ? { createFailedByStatus: failedByStatus }
        : {}),
      notAttempted,
    },
    ...(a.sentencesFile !== undefined
      ? {
          sentences: sentenceTotals(rows.length, run),
          batches: run.totals.batches,
        }
      : {}),
    ...(nonEmpty(skipped) ? { skipped } : {}),
    ...(nonEmpty(notDone) ? { notDone } : {}),
    ...(parentsNeedingChildFeatures.length > 0
      ? {
          parentsNeedingChildFeatures: {
            count: parentsNeedingChildFeatures.length,
            names: firstNames(parentsNeedingChildFeatures),
          },
        }
      : {}),
    ...(nonEmpty(names) ? { names } : {}),
  };
  return finishResult(
    out,
    createFailed.length > 0 || notAttempted > 0 || nonEmpty(notDone),
    failedByStatus,
  );
}
