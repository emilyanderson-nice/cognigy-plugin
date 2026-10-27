import { describe, expect, it, jest } from "@jest/globals";
import type { IntentApi } from "../tools/intents/types.js";
import { buildTree } from "../tools/intents/tree.js";
import {
  importSentences,
  MAX_EXISTING_PAGES,
  MAX_SENTENCES_PER_INTENT,
  SENTENCE_BATCH_SIZE,
} from "../tools/intents/sentences.js";

const FLOW = "ffffffffffffffffffffff01";
const id = (n: number): string => "a".repeat(22) + String(n).padStart(2, "0");
const ALPHA = id(1);
const BETA = id(2);
const GAMMA = id(3);
const CHILD = id(4);
const TWIN1 = id(5);
const TWIN2 = id(6);

const SENTENCES_PATH = (intentId: string): string =>
  `/v2.0/flows/${FLOW}/intents/${intentId}/sentences`;

const SENTINEL_ERR = "SENTINEL_UPSTREAM_ERROR_TEXT_91";
const SENTINEL_SENTENCE = "SENTINEL_SENTENCE_TEXT_77";

const tree = buildTree([
  { id: ALPHA, name: "Alpha", parentId: null },
  { id: BETA, name: "Beta", parentId: null },
  { id: GAMMA, name: "Gamma", parentId: null },
  { id: CHILD, name: "Child", parentId: ALPHA },
  { id: TWIN1, name: "Twin", parentId: null },
  { id: TWIN2, name: "Twin", parentId: null },
]);

interface Call {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  params?: Record<string, unknown>;
  body?: any;
}

interface FakeOptions {
  existing?: Record<string, string[]>;
  pageSize?: number;
  /** Return an error to make this PATCH attempt reject. patchNo is 1-based per intent. */
  failPatch?: (intentId: string, patchNo: number) => Error | undefined;
  onGet?: (intentId: string) => void;
  /** Make the sentences GET reject for this intent. */
  getError?: (intentId: string) => Error | undefined;
  /** Replace the page returned for an intent. callNo is 1-based per intent. */
  pageOverride?: (
    intentId: string,
    callNo: number,
  ) =>
    | { items: Array<{ _id: string; text: string }>; nextCursor: string | null }
    | undefined;
  onPatch?: (intentId: string) => void;
}

/** The real client throws a plain Error with a numeric .status and no .response. */
function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const ERROR_SHAPES: Array<
  [string, (status: number, message: string) => Error]
> = [
  ["err.response.status", (s, m) => httpError(s, m)],
  ["err.status (no response)", (s, m) => statusError(s, m)],
];

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    response: { status, data: { message } },
  });
}

function makeFake(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const state = new Map<string, Array<{ _id: string; text: string }>>();
  for (const [intentId, texts] of Object.entries(options.existing ?? {})) {
    state.set(
      intentId,
      texts.map((text, i) => ({ _id: `${intentId}-s${i}`, text })),
    );
  }
  const patchCounts = new Map<string, number>();
  const getCounts = new Map<string, number>();
  let created = 0;

  const route = (path: string): string => {
    const m = /^\/v2\.0\/flows\/[^/]+\/intents\/([^/]+)\/sentences$/.exec(path);
    if (!m) throw new Error(`unexpected path ${path}`);
    return m[1];
  };

  const get = jest.fn<IntentApi["get"]>(async (path, config) => {
    calls.push({ method: "get", path, params: config?.params });
    const intentId = route(path);
    options.onGet?.(intentId);
    const readErr = options.getError?.(intentId);
    if (readErr) throw readErr;
    const callNo = (getCounts.get(intentId) ?? 0) + 1;
    getCounts.set(intentId, callNo);
    const overridden = options.pageOverride?.(intentId, callNo);
    if (overridden) return overridden;
    const all = state.get(intentId) ?? [];
    const next = config?.params?.next;
    const start =
      next === undefined ? 0 : Number(String(next).replace("cur-", ""));
    const size = options.pageSize ?? 100;
    const end = Math.min(start + size, all.length);
    return {
      items: all.slice(start, end).map((s) => ({ ...s })),
      nextCursor: end < all.length ? `cur-${end}` : null,
    };
  });

  const patch = jest.fn<IntentApi["patch"]>(async (path, body) => {
    calls.push({ method: "patch", path, body });
    const intentId = route(path);
    const n = (patchCounts.get(intentId) ?? 0) + 1;
    patchCounts.set(intentId, n);
    const err = options.failPatch?.(intentId, n);
    if (err) throw err;
    const list = state.get(intentId) ?? [];
    for (const op of body.operations) {
      if (op.op === "create") {
        list.push({ _id: `new-${created++}`, text: op.value.text });
      } else if (op.op === "delete") {
        const i = list.findIndex((s) => s._id === op.id);
        if (i >= 0) list.splice(i, 1);
      }
    }
    state.set(intentId, list);
    options.onPatch?.(intentId);
    return {};
  });

  const post = jest.fn<IntentApi["post"]>(async (path, body) => {
    calls.push({ method: "post", path, body });
    return {};
  });
  const del = jest.fn<IntentApi["delete"]>(async (path) => {
    calls.push({ method: "delete", path });
    return {};
  });

  const api: IntentApi = { get, post, patch, delete: del };
  return {
    api,
    calls,
    state,
    patches: () => calls.filter((c) => c.method === "patch"),
    gets: () => calls.filter((c) => c.method === "get"),
    ops: (c: Call) => c.body.operations as Array<Record<string, any>>,
    texts: (intentId: string) => (state.get(intentId) ?? []).map((s) => s.text),
  };
}

const gen = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix} sample ${i + 1}`);

const create = (text: string) => ({ op: "create", value: { text } });

describe("sentence constants", () => {
  it("batch size is 50 and per-intent cap is 200", () => {
    expect(SENTENCE_BATCH_SIZE).toBe(50);
    expect(MAX_SENTENCES_PER_INTENT).toBe(200);
  });
});

describe("importSentences: intent resolution", () => {
  it("refuses with zero api calls when an intent is not found, listing every failure", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Nope", sentences: [SENTINEL_SENTENCE] },
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Missing/Path", sentences: ["alpha sample two"] },
      ],
      { mode: "add" },
    );
    expect(result).toEqual({
      ok: false,
      error: "unresolved_intents",
      problems: [
        { intent: "Nope", error: "not_found" },
        { intent: "Missing/Path", error: "not_found" },
      ],
    });
    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
  });

  it("refuses with zero api calls when an intent is ambiguous, including candidates in order", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Twin", sentences: ["twin sample one"] },
      ],
      { mode: "replace" },
    );
    expect(result).toEqual({
      ok: false,
      error: "unresolved_intents",
      problems: [
        { intent: "Twin", error: "ambiguous", candidates: [TWIN1, TWIN2] },
      ],
    });
    expect(fake.calls).toEqual([]);
  });

  it("merges entries that resolve to the same intent into one read and one patch, in entry order", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        {
          intent: "Alpha",
          sentences: ["alpha sample one", "alpha sample two"],
        },
        { intent: ALPHA, sentences: ["alpha sample three"] },
      ],
      { mode: "add" },
    );
    expect(fake.gets()).toHaveLength(1);
    expect(fake.patches()).toHaveLength(1);
    expect(fake.ops(fake.patches()[0])).toEqual([
      create("alpha sample one"),
      create("alpha sample two"),
      create("alpha sample three"),
    ]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 3,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 3,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
  });

  it("reports the node name even when the entry used an id or a Parent/Child path", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha/Child", sentences: ["child sample one"] },
        { intent: BETA, sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents.map((i) => [i.intent, i.id])).toEqual([
      ["Child", CHILD],
      ["Beta", BETA],
    ]);
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENTENCES_PATH(CHILD),
      SENTENCES_PATH(BETA),
    ]);
  });

  it("processes intents one after another in entry order, not tree order", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Gamma", sentences: ["gamma sample one"] },
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents.map((i) => i.intent)).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENTENCES_PATH(GAMMA),
      SENTENCES_PATH(ALPHA),
      SENTENCES_PATH(BETA),
    ]);
  });
});

describe("importSentences: duplicates and payloads", () => {
  it("drops repeats (exact after trimming, first kept), counts them, and drops empties silently", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        {
          intent: "Alpha",
          sentences: [
            "alpha one",
            "alpha one ",
            "beta two",
            "   ",
            "",
            "alpha one",
          ],
        },
      ],
      { mode: "add" },
    );
    expect(fake.ops(fake.patches()[0])).toEqual([
      create("alpha one"),
      create("beta two"),
    ]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 2,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
  });

  it("sends the exact path and operation shapes", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["old one"] } });
    await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["new one"] }],
      { mode: "replace" },
    );
    expect(fake.calls).toEqual([
      { method: "get", path: SENTENCES_PATH(ALPHA), params: { limit: 100 } },
      {
        method: "patch",
        path: SENTENCES_PATH(ALPHA),
        body: {
          operations: [
            { op: "delete", id: `${ALPHA}-s0` },
            { op: "create", value: { text: "new one" } },
          ],
        },
      },
    ]);
  });
});

describe("importSentences: add mode", () => {
  it("creates only sentences not already present, counts the rest as skippedExisting, never deletes", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: ["have one", "have two", "unrelated"] },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        {
          intent: "Alpha",
          sentences: ["have one", "fresh one", "have two", "fresh two"],
        },
      ],
      { mode: "add" },
    );
    expect(fake.ops(fake.patches()[0])).toEqual([
      create("fresh one"),
      create("fresh two"),
    ]);
    expect(fake.texts(ALPHA)).toEqual([
      "have one",
      "have two",
      "unrelated",
      "fresh one",
      "fresh two",
    ]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 2,
        deleted: 0,
        skippedExisting: 2,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 2,
          deleted: 0,
          skippedExisting: 2,
          status: "ok",
        },
      ],
    });
  });

  it("is idempotent: a second identical run makes zero patch calls and reports created 0", async () => {
    const fake = makeFake();
    const entries = [{ intent: "Alpha", sentences: gen("alpha", 3) }];
    const first = await importSentences(fake.api, FLOW, tree, entries, {
      mode: "add",
    });
    if (!first.ok) throw new Error("expected ok");
    expect(first.totals.created).toBe(3);
    expect(fake.patches()).toHaveLength(1);

    const second = await importSentences(fake.api, FLOW, tree, entries, {
      mode: "add",
    });
    expect(fake.patches()).toHaveLength(1);
    expect(second).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 3,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 3,
          status: "ok",
        },
      ],
    });
  });
});

describe("importSentences: replace mode", () => {
  it("deletes only changed-out sentences, creates only new ones, counts kept ones", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: ["keep one", "keep two", "old one", "old two"] },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["keep one", "keep two", "new one"] }],
      { mode: "replace" },
    );
    expect(fake.patches()).toHaveLength(1);
    expect(fake.ops(fake.patches()[0])).toEqual([
      { op: "delete", id: `${ALPHA}-s2` },
      { op: "delete", id: `${ALPHA}-s3` },
      create("new one"),
    ]);
    expect(fake.texts(ALPHA)).toEqual(["keep one", "keep two", "new one"]);
    expect(result).toEqual({
      ok: true,
      mode: "replace",
      status: "complete",
      totals: {
        created: 1,
        deleted: 2,
        skippedExisting: 2,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 1,
          deleted: 2,
          skippedExisting: 2,
          status: "ok",
        },
      ],
    });
  });

  it("sends all deletes before any create, even when they share a batch", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["old one", "old two"] } });
    await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["new one", "new two", "new three"] }],
      { mode: "replace" },
    );
    expect(fake.patches()).toHaveLength(1);
    expect(fake.ops(fake.patches()[0])).toEqual([
      { op: "delete", id: `${ALPHA}-s0` },
      { op: "delete", id: `${ALPHA}-s1` },
      create("new one"),
      create("new two"),
      create("new three"),
    ]);
  });

  it("keeps deletes ahead of creates across a batch boundary (49 deletes + 3 creates -> 50 and 2)", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 49) } });
    await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 3) }],
      { mode: "replace" },
    );
    const batches = fake.patches().map((c) => fake.ops(c));
    expect(batches.map((b) => b.length)).toEqual([50, 2]);
    expect(batches[0].slice(0, 49).every((o) => o.op === "delete")).toBe(true);
    expect(batches[0][49]).toEqual(create("new sample 1"));
    expect(batches[1]).toEqual([
      create("new sample 2"),
      create("new sample 3"),
    ]);
  });

  it("allows 20 new sentences in replace mode over 190 existing ones (deletes then creates, 5 patches)", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 190) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 20) }],
      { mode: "replace" },
    );
    expect(fake.patches().map((c) => fake.ops(c).length)).toEqual([
      50, 50, 50, 50, 10,
    ]);
    expect(fake.texts(ALPHA)).toEqual(gen("new", 20));
    expect(result).toEqual({
      ok: true,
      mode: "replace",
      status: "complete",
      totals: {
        created: 20,
        deleted: 190,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 5,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 20,
          deleted: 190,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
  });

  it("refuses in replace mode when the distinct new sentences alone exceed 200, with no patch", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 3) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 201) }],
      { mode: "replace" },
    );
    expect(result).toEqual({
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [{ intent: "Alpha", id: ALPHA, wouldHave: 201, cap: 200 }],
    });
    expect(fake.patches()).toEqual([]);
  });

  it("counts distinct sentences, not repeats, toward the replace cap", async () => {
    const fake = makeFake();
    const sentences = [...gen("new", 200), ...gen("new", 5)];
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences }],
      {
        mode: "replace",
      },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals.created).toBe(200);
    expect(result.totals.duplicatesDropped).toBe(5);
  });
});

describe("importSentences: cap in add mode", () => {
  it("refuses 190 existing + 20 new (210) and sends no patch, listing every offending intent", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: gen("old", 190), [BETA]: gen("beta", 195) },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: gen("new", 20) },
        { intent: "Gamma", sentences: ["gamma sample one"] },
        { intent: "Beta", sentences: gen("more", 6) },
      ],
      { mode: "add" },
    );
    expect(result).toEqual({
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [
        { intent: "Alpha", id: ALPHA, wouldHave: 210, cap: 200 },
        { intent: "Beta", id: BETA, wouldHave: 201, cap: 200 },
      ],
    });
    expect(fake.patches()).toEqual([]);
  });

  it("does not count new sentences that already exist toward the cap", async () => {
    const existing = gen("old", 190);
    const fake = makeFake({ existing: { [ALPHA]: existing } });
    // 5 already present + 10 genuinely new -> 200, allowed
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        {
          intent: "Alpha",
          sentences: [...existing.slice(0, 5), ...gen("new", 10)],
        },
      ],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals).toEqual({
      created: 10,
      deleted: 0,
      skippedExisting: 5,
      duplicatesDropped: 0,
      batches: 1,
    });
    expect(fake.texts(ALPHA)).toHaveLength(200);
  });

  it("refuses at 201 (existing 190 + 11 new)", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 190) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 11) }],
      { mode: "add" },
    );
    expect(result).toEqual({
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [{ intent: "Alpha", id: ALPHA, wouldHave: 201, cap: 200 }],
    });
    expect(fake.patches()).toEqual([]);
  });
});

describe("importSentences: batching", () => {
  it("makes no PATCH when there are no operations", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: [] }],
      {
        mode: "add",
      },
    );
    expect(fake.patches()).toEqual([]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
  });

  it.each([
    [50, [50]],
    [51, [50, 1]],
    [120, [50, 50, 20]],
  ])("splits %i creates into patches of %j", async (count, sizes) => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("alpha", count) }],
      { mode: "add" },
    );
    const batches = fake.patches().map((c) => fake.ops(c));
    expect(batches.map((b) => b.length)).toEqual(sizes);
    expect(batches.flat()).toEqual(gen("alpha", count).map(create));
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals.batches).toBe(sizes.length);
    expect(result.totals.created).toBe(count);
  });
});

describe("importSentences: reading existing sentences", () => {
  it("follows nextCursor: first call params {limit:100}, later calls add next", async () => {
    const existing = gen("have", 5);
    const fake = makeFake({ existing: { [ALPHA]: existing }, pageSize: 2 });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: [...existing, "fresh one"] }],
      { mode: "add" },
    );
    expect(fake.gets().map((c) => c.params)).toEqual([
      { limit: 100 },
      { limit: 100, next: "cur-2" },
      { limit: 100, next: "cur-4" },
    ]);
    expect(fake.ops(fake.patches()[0])).toEqual([create("fresh one")]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals.skippedExisting).toBe(5);
    expect(result.totals.created).toBe(1);
  });

  it("reads every intent's existing sentences before the first patch", async () => {
    const fake = makeFake();
    await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    expect(fake.calls.map((c) => c.method)).toEqual([
      "get",
      "get",
      "patch",
      "patch",
    ]);
  });
});

describe("importSentences: partial failure", () => {
  it("marks the failing intent failed with httpStatus, stops its batches, continues with the next intent", async () => {
    const fake = makeFake({
      failPatch: (intentId, n) =>
        intentId === BETA && n === 2 ? httpError(500, SENTINEL_ERR) : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: gen("alpha", 2) },
        { intent: "Beta", sentences: gen("beta", 120) },
        { intent: "Gamma", sentences: gen("gamma", 3) },
      ],
      { mode: "add" },
    );
    // Alpha 1 patch, Beta 2 attempts (batch 3 never sent), Gamma 1 patch
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENTENCES_PATH(ALPHA),
      SENTENCES_PATH(BETA),
      SENTENCES_PATH(BETA),
      SENTENCES_PATH(GAMMA),
    ]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "partial",
      totals: {
        created: 55,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 3,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
        {
          intent: "Beta",
          id: BETA,
          created: 50,
          deleted: 0,
          skippedExisting: 0,
          status: "failed",
          httpStatus: 500,
        },
        {
          intent: "Gamma",
          id: GAMMA,
          created: 3,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("counts nothing for an intent whose first batch fails, and omits httpStatus when the error has none", async () => {
    const fake = makeFake({
      failPatch: (intentId) =>
        intentId === ALPHA ? new Error(SENTINEL_ERR) : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("alpha", 3) }],
      { mode: "add" },
    );
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "partial",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 0,
          status: "failed",
        },
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents[0]).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("counts only succeeded deletes and creates in a replace that fails on its second batch", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: gen("old", 60) },
      failPatch: (_intentId, n) =>
        n === 2 ? httpError(500, SENTINEL_ERR) : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 10) }],
      { mode: "replace" },
    );
    // 60 deletes + 10 creates = 70 ops -> batch 1: 50 deletes (ok), batch 2: 10 deletes + 10 creates (fails)
    expect(result).toEqual({
      ok: true,
      mode: "replace",
      status: "partial",
      totals: {
        created: 0,
        deleted: 50,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 50,
          skippedExisting: 0,
          status: "failed",
          httpStatus: 500,
        },
      ],
    });
  });
});

describe("importSentences: deadline", () => {
  it("stops before the next existing-sentences read: nothing is written and all intents are not_attempted", async () => {
    let t = 0;
    const fake = makeFake({
      onGet: () => {
        t = 1000;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add", deadlineMs: 1000, now: () => t },
    );
    expect(fake.gets()).toHaveLength(1);
    expect(fake.patches()).toEqual([]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("partial");
    expect(result.intents.map((i) => [i.intent, i.status, i.created])).toEqual([
      ["Alpha", "not_attempted", 0],
      ["Beta", "not_attempted", 0],
    ]);
    expect(result.totals.batches).toBe(0);
    expect(result.totals.created).toBe(0);
  });

  it("stops before the next PATCH once the deadline has passed; a partly written intent is incomplete, an untouched one not_attempted", async () => {
    let t = 0;
    const fake = makeFake({
      onPatch: () => {
        t = 1000;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: gen("alpha", 120) },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add", deadlineMs: 1000, now: () => t },
    );
    expect(fake.patches()).toHaveLength(1);
    expect(fake.ops(fake.patches()[0])).toHaveLength(50);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("partial");
    expect(result.intents.map((i) => [i.intent, i.status])).toEqual([
      ["Alpha", "incomplete"],
      ["Beta", "not_attempted"],
    ]);
    expect(result.intents[0].created).toBe(50);
    expect(result.intents[1].created).toBe(0);
    expect(result.totals.batches).toBe(1);
    expect(result.totals.created).toBe(50);
  });

  it("defaults the deadline to 60000 ms: 59999 elapsed still writes", async () => {
    let t = 0;
    const fake = makeFake({
      onGet: () => {
        t = 59999;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha sample one"] }],
      { mode: "add", now: () => t },
    );
    expect(fake.patches()).toHaveLength(1);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("complete");
  });

  it("defaults the deadline to 60000 ms: 60000 elapsed stops before the PATCH", async () => {
    let t = 0;
    const fake = makeFake({
      onGet: () => {
        t = 60000;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha sample one"] }],
      { mode: "add", now: () => t },
    );
    expect(fake.patches()).toEqual([]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("partial");
    expect(result.intents[0].status).toBe("not_attempted");
  });

  it("measures elapsed time from the start of the call, not from clock zero", async () => {
    let t = 5_000_000;
    const fake = makeFake({
      onGet: () => {
        t += 500;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha sample one"] }],
      { mode: "add", deadlineMs: 1000, now: () => t },
    );
    expect(fake.patches()).toHaveLength(1);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("complete");
  });
});

describe("importSentences: existing sentences compared trimmed", () => {
  it("add mode: an existing 'alpha ' counts as present for a new 'alpha' (skipped, no create, no patch)", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["alpha "] } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha"] }],
      { mode: "add" },
    );
    expect(fake.patches()).toEqual([]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 1,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 1,
          status: "ok",
        },
      ],
    });
  });

  it("replace mode: the padded existing sentence is kept, only the other one is deleted", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["alpha ", "old one"] } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha"] }],
      { mode: "replace" },
    );
    expect(fake.patches()).toHaveLength(1);
    expect(fake.ops(fake.patches()[0])).toEqual([
      { op: "delete", id: `${ALPHA}-s1` },
    ]);
    expect(result).toEqual({
      ok: true,
      mode: "replace",
      status: "complete",
      totals: {
        created: 0,
        deleted: 1,
        skippedExisting: 1,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 1,
          skippedExisting: 1,
          status: "ok",
        },
      ],
    });
  });
});

describe("importSentences: cursor safety", () => {
  const page = (n: number, nextCursor: string | null) => ({
    items: [{ _id: `p${n}-s`, text: `page ${n} sample` }],
    nextCursor,
  });

  it("exports MAX_EXISTING_PAGES = 20", () => {
    expect(MAX_EXISTING_PAGES).toBe(20);
  });

  it("fails the intent (no httpStatus, no PATCH) when the same nextCursor repeats, and continues", async () => {
    const fake = makeFake({
      pageOverride: (intentId, callNo) =>
        intentId === ALPHA ? page(callNo, "same-cursor") : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    expect(
      fake.gets().filter((c) => c.path === SENTENCES_PATH(ALPHA)),
    ).toHaveLength(2);
    expect(fake.patches().map((c) => c.path)).toEqual([SENTENCES_PATH(BETA)]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "partial",
      totals: {
        created: 1,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 0,
          status: "failed",
        },
        {
          intent: "Beta",
          id: BETA,
          created: 1,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents[0]).not.toHaveProperty("httpStatus");
  });

  it("fails the intent when a nextCursor is still present after the 20th page, never requesting a 21st", async () => {
    const fake = makeFake({
      pageOverride: (intentId, callNo) =>
        intentId === ALPHA ? page(callNo, `cursor-${callNo}`) : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: ["alpha sample one"] },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    expect(
      fake.gets().filter((c) => c.path === SENTENCES_PATH(ALPHA)),
    ).toHaveLength(20);
    expect(fake.patches().map((c) => c.path)).toEqual([SENTENCES_PATH(BETA)]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("partial");
    expect(result.intents[0]).toEqual({
      intent: "Alpha",
      id: ALPHA,
      created: 0,
      deleted: 0,
      skippedExisting: 0,
      status: "failed",
    });
    expect(result.intents[1].status).toBe("ok");
  });

  it("accepts exactly 20 pages when the 20th has no nextCursor", async () => {
    const fake = makeFake({
      pageOverride: (intentId, callNo) =>
        intentId === ALPHA
          ? page(callNo, callNo < 20 ? `cursor-${callNo}` : null)
          : undefined,
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["page 3 sample", "fresh one"] }],
      { mode: "add" },
    );
    expect(fake.gets()).toHaveLength(20);
    expect(fake.ops(fake.patches()[0])).toEqual([create("fresh one")]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("complete");
    expect(result.totals.skippedExisting).toBe(1);
  });
});

describe("importSentences: httpStatus for both error shapes", () => {
  it.each(ERROR_SHAPES)(
    "failed existing-sentence read reports httpStatus 404 via %s, no PATCH for it, next intent continues",
    async (_label, mk) => {
      const fake = makeFake({
        getError: (intentId) =>
          intentId === ALPHA ? mk(404, SENTINEL_ERR) : undefined,
      });
      const result = await importSentences(
        fake.api,
        FLOW,
        tree,
        [
          { intent: "Alpha", sentences: [SENTINEL_SENTENCE] },
          { intent: "Beta", sentences: ["beta sample one"] },
        ],
        { mode: "add" },
      );
      expect(fake.patches().map((c) => c.path)).toEqual([SENTENCES_PATH(BETA)]);
      expect(result).toEqual({
        ok: true,
        mode: "add",
        status: "partial",
        totals: {
          created: 1,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
          batches: 1,
        },
        intents: [
          {
            intent: "Alpha",
            id: ALPHA,
            created: 0,
            deleted: 0,
            skippedExisting: 0,
            status: "failed",
            httpStatus: 404,
          },
          {
            intent: "Beta",
            id: BETA,
            created: 1,
            deleted: 0,
            skippedExisting: 0,
            status: "ok",
          },
        ],
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain(SENTINEL_ERR);
      expect(json).not.toContain(SENTINEL_SENTENCE);
    },
  );

  it.each(ERROR_SHAPES)(
    "failed PATCH reports httpStatus 500 via %s and keeps only successful batches",
    async (_label, mk) => {
      const fake = makeFake({
        failPatch: (intentId, n) =>
          intentId === ALPHA && n === 2 ? mk(500, SENTINEL_ERR) : undefined,
      });
      const result = await importSentences(
        fake.api,
        FLOW,
        tree,
        [
          { intent: "Alpha", sentences: gen("alpha", 120) },
          { intent: "Beta", sentences: ["beta sample one"] },
        ],
        { mode: "add" },
      );
      expect(result).toEqual({
        ok: true,
        mode: "add",
        status: "partial",
        totals: {
          created: 51,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
          batches: 2,
        },
        intents: [
          {
            intent: "Alpha",
            id: ALPHA,
            created: 50,
            deleted: 0,
            skippedExisting: 0,
            status: "failed",
            httpStatus: 500,
          },
          {
            intent: "Beta",
            id: BETA,
            created: 1,
            deleted: 0,
            skippedExisting: 0,
            status: "ok",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    },
  );

  it("prefers err.response.status over err.status when both are numeric", async () => {
    const both = Object.assign(new Error(SENTINEL_ERR), {
      status: 418,
      response: { status: 503 },
    });
    const fake = makeFake({ failPatch: () => both });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha sample one"] }],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents[0].httpStatus).toBe(503);
  });

  it("omits httpStatus when err.status is not numeric", async () => {
    const odd = Object.assign(new Error(SENTINEL_ERR), { status: "500" });
    const fake = makeFake({ failPatch: () => odd });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["alpha sample one"] }],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.intents[0].status).toBe("failed");
    expect(result.intents[0]).not.toHaveProperty("httpStatus");
  });
});

describe("importSentences: empty replace and legacy over-cap intents", () => {
  it("replace with no non-blank sentences returns empty_replace listing every such intent, with zero api calls", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: ["keep me"], [BETA]: ["keep me too"] },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: [] },
        { intent: "Gamma", sentences: ["gamma sample one"] },
        { intent: BETA, sentences: ["   ", ""] },
      ],
      { mode: "replace" },
    );
    expect(result).toEqual({
      ok: false,
      error: "empty_replace",
      problems: [
        { intent: "Alpha", id: ALPHA },
        { intent: "Beta", id: BETA },
      ],
    });
    expect(fake.calls).toEqual([]);
  });

  it("replace: two entries for one intent whose merged list is blank are still refused", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: [" "] },
        { intent: ALPHA, sentences: [] },
      ],
      { mode: "replace" },
    );
    expect(result).toEqual({
      ok: false,
      error: "empty_replace",
      problems: [{ intent: "Alpha", id: ALPHA }],
    });
    expect(fake.calls).toEqual([]);
  });

  it("replace: a merged non-blank sentence from a second entry makes the intent valid", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["old one"] } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: [] },
        { intent: ALPHA, sentences: ["new one"] },
      ],
      { mode: "replace" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals.created).toBe(1);
    expect(result.totals.deleted).toBe(1);
  });

  it("add mode with an empty list stays a no-op: reads, no PATCH, complete", async () => {
    const fake = makeFake({ existing: { [ALPHA]: ["have one"] } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: [] }],
      { mode: "add" },
    );
    expect(fake.patches()).toEqual([]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
  });

  it("add mode: an intent already over 200 that receives nothing new is not refused", async () => {
    const existing = gen("old", 205);
    const fake = makeFake({ existing: { [ALPHA]: existing } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: existing.slice(0, 3) }],
      { mode: "add" },
    );
    expect(fake.patches()).toEqual([]);
    expect(result).toEqual({
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 3,
        duplicatesDropped: 0,
        batches: 0,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 0,
          skippedExisting: 3,
          status: "ok",
        },
      ],
    });
  });

  it("add mode: an intent already over 200 that would receive one new sentence is refused (wouldHave 206)", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 205) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["fresh one"] }],
      { mode: "add" },
    );
    expect(result).toEqual({
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [{ intent: "Alpha", id: ALPHA, wouldHave: 206, cap: 200 }],
    });
    expect(fake.patches()).toEqual([]);
  });

  it("add mode: a legacy over-cap intent without new sentences does not block another intent's import", async () => {
    const existing = gen("old", 205);
    const fake = makeFake({ existing: { [ALPHA]: existing } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        { intent: "Alpha", sentences: existing.slice(0, 2) },
        { intent: "Beta", sentences: ["beta sample one"] },
      ],
      { mode: "add" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("complete");
    expect(fake.patches().map((c) => c.path)).toEqual([SENTENCES_PATH(BETA)]);
  });

  it("replace mode: a legacy over-cap intent is replaced by a list within the cap", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 205) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: ["only one"] }],
      { mode: "replace" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.totals).toEqual({
      created: 1,
      deleted: 205,
      skippedExisting: 0,
      duplicatesDropped: 0,
      batches: 5,
    });
    expect(fake.texts(ALPHA)).toEqual(["only one"]);
  });

  it("replace mode: a distinct new count of 201 is refused even over a legacy over-cap intent", async () => {
    const fake = makeFake({ existing: { [ALPHA]: gen("old", 205) } });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 201) }],
      { mode: "replace" },
    );
    expect(result).toEqual({
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [{ intent: "Alpha", id: ALPHA, wouldHave: 201, cap: 200 }],
    });
    expect(fake.patches()).toEqual([]);
  });
});

describe("importSentences: incomplete status", () => {
  it("a deadline after the only batch of an intent with unsent work in a replace marks it incomplete with exact counts", async () => {
    let t = 0;
    const fake = makeFake({
      existing: { [ALPHA]: gen("old", 60) },
      onPatch: () => {
        t = 1000;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("new", 10) }],
      { mode: "replace", deadlineMs: 1000, now: () => t },
    );
    expect(fake.patches()).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      mode: "replace",
      status: "partial",
      totals: {
        created: 0,
        deleted: 50,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Alpha",
          id: ALPHA,
          created: 0,
          deleted: 50,
          skippedExisting: 0,
          status: "incomplete",
        },
      ],
    });
  });

  it("an intent whose last batch was sent before the deadline is ok, not incomplete", async () => {
    let t = 0;
    const fake = makeFake({
      onPatch: () => {
        t = 1000;
      },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen("alpha", 50) }],
      { mode: "add", deadlineMs: 1000, now: () => t },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe("complete");
    expect(result.intents[0].status).toBe("ok");
  });
});

describe("importSentences: privacy", () => {
  it("never puts sentence text in a successful result", async () => {
    const fake = makeFake({
      existing: { [ALPHA]: [`${SENTINEL_SENTENCE} existing`] },
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [
        {
          intent: "Alpha",
          sentences: [
            `${SENTINEL_SENTENCE} one`,
            `${SENTINEL_SENTENCE} one`,
            `${SENTINEL_SENTENCE} existing`,
          ],
        },
      ],
      { mode: "replace" },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
  });

  it("never puts sentence text in a cap refusal", async () => {
    const fake = makeFake();
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: gen(SENTINEL_SENTENCE, 201) }],
      { mode: "replace" },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
  });

  it("never puts the upstream error message or sentence text in a failed-batch result", async () => {
    const fake = makeFake({
      failPatch: () => httpError(500, `${SENTINEL_ERR} ${SENTINEL_SENTENCE}`),
    });
    const result = await importSentences(
      fake.api,
      FLOW,
      tree,
      [{ intent: "Alpha", sentences: [`${SENTINEL_SENTENCE} one`] }],
      { mode: "add" },
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });
});
