import { describe, it, expect, jest } from "@jest/globals";
import { buildTree } from "../tools/intents/tree.js";
import type { IntentInput, IntentTree } from "../tools/intents/tree.js";
import { MAX_EXISTING_PAGES } from "../tools/intents/sentences.js";
import type { IntentApi } from "../tools/intents/types.js";
import {
  readFlowIntents,
  getIntent,
  exportTree,
  LIST_PAGE_SIZE,
  MAX_LIST_PAGES,
  DEFAULT_CONCURRENCY,
} from "../tools/intents/reader.js";
import type {
  FlowIntents,
  ReadResult,
  IntentSummary,
} from "../tools/intents/reader.js";

// ---------------------------------------------------------------------------
// Synthetic in-memory fake of the intents API. Records every call and tracks
// the peak number of requests in flight for the single-intent and sentence GETs.
// ---------------------------------------------------------------------------

const FLOW = "ffffffffffffffffffffff01";
const LIST_PATH = `/v2.0/flows/${FLOW}/intents`;
const SENTINEL_SENTENCE = "SENTINEL_SENTENCE_TEXT_zq91";
const SENTINEL_ERROR = "SENTINEL_UPSTREAM_ERROR_zq91";

const id = (n: number): string => "a".repeat(20) + String(n).padStart(4, "0");
const singlePath = (intentId: string): string => `${LIST_PATH}/${intentId}`;
const sentencesPath = (intentId: string): string =>
  `${LIST_PATH}/${intentId}/sentences`;

interface RawIntent {
  _id: string;
  name: string;
  parentIntentId?: string | null;
  biasTowardsParentOrChildIntents?: unknown;
  feedbackReport?: unknown;
}

const raw = (
  n: number,
  name: string,
  parent?: number | null,
  extra: Partial<RawIntent> = {},
): RawIntent => ({
  _id: id(n),
  name,
  ...(parent === undefined
    ? {}
    : { parentIntentId: parent === null ? null : id(parent) }),
  ...extra,
});

interface Call {
  path: string;
  params?: Record<string, unknown>;
}

interface FakeConfig {
  intents?: RawIntent[];
  pageSize?: number;
  listTotal?: unknown;
  childFeatures?: Record<string, unknown>;
  sentenceTotals?: Record<string, unknown>;
  sentenceTexts?: Record<string, string[]>;
  sentencePageSize?: number;
  failSingle?: string[];
  failSentences?: string[];
  failStatus?: number;
  failShape?: "response" | "status";
  list?: (params: Record<string, unknown>, index: number) => Promise<any>;
  sentenceList?: (
    intentId: string,
    params: Record<string, unknown>,
    index: number,
  ) => Promise<any>;
  afterList?: () => void;
  afterSentenceCount?: () => void;
  delayMs?: number;
}

function upstreamError(status?: number): Error {
  const e = new Error(SENTINEL_ERROR);
  return status === undefined ? e : Object.assign(e, { response: { status } });
}

// The real client rejects with a plain Error that has a numeric `status` and no `response`.
function clientError(status: number): Error {
  return Object.assign(new Error(SENTINEL_ERROR), { status });
}

function makeFake(cfg: FakeConfig = {}) {
  const calls: Call[] = [];
  const intents = cfg.intents ?? [];
  const failure = (): Error =>
    cfg.failShape === "status" && cfg.failStatus !== undefined
      ? clientError(cfg.failStatus)
      : upstreamError(cfg.failStatus);
  let inFlight = 0;
  let peak = 0;
  let listIndex = 0;
  let sentenceListIndex = 0;
  const delay = (): Promise<void> =>
    new Promise((r) => setTimeout(r, cfg.delayMs ?? 2));

  const get = jest.fn(
    async (
      path: string,
      config?: { params?: Record<string, unknown> },
    ): Promise<any> => {
      const params = config?.params;
      calls.push({ path, params });
      const m = path.match(
        /^\/v2\.0\/flows\/([^/]+)\/intents(?:\/([^/]+)(\/sentences)?)?$/,
      );
      if (!m) throw new Error(`unexpected path ${path}`);
      const intentId = m[2];

      if (!intentId) {
        const index = listIndex++;
        try {
          if (cfg.list) return await cfg.list(params ?? {}, index);
          const withChildren = params?.includeChildren === true;
          const base = withChildren
            ? intents
            : intents.filter((i) => !i.parentIntentId);
          const offset = params?.next ? Number(params.next) : 0;
          const size = cfg.pageSize ?? LIST_PAGE_SIZE;
          const items = base.slice(offset, offset + size).map((i) => {
            const copy = { ...i };
            if (params?.includeFeedbackReport !== true)
              delete copy.feedbackReport;
            return copy;
          });
          const next = offset + size;
          return {
            items,
            ...(cfg.listTotal === undefined
              ? { total: base.length }
              : { total: cfg.listTotal }),
            nextCursor: next < base.length ? String(next) : null,
          };
        } finally {
          cfg.afterList?.();
        }
      }

      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await delay();
        if (!m[3]) {
          if (cfg.failSingle?.includes(intentId)) throw failure();
          const map = cfg.childFeatures ?? {};
          return {
            _id: intentId,
            childFeatures: intentId in map ? map[intentId] : true,
          };
        }
        if (cfg.failSentences?.includes(intentId)) throw failure();
        const texts = cfg.sentenceTexts?.[intentId] ?? [];
        const toItem = (t: string, i: number) => ({
          _id: `s${intentId}${i}`,
          text: t,
        });
        if (params?.limit === 1) {
          const totals = cfg.sentenceTotals ?? {};
          const total = intentId in totals ? totals[intentId] : texts.length;
          const res = { items: texts.slice(0, 1).map(toItem), total };
          cfg.afterSentenceCount?.();
          return res;
        }
        const index = sentenceListIndex++;
        if (cfg.sentenceList)
          return await cfg.sentenceList(intentId, params ?? {}, index);
        const offset = params?.next ? Number(params.next) : 0;
        const size = cfg.sentencePageSize ?? 100;
        const next = offset + size;
        return {
          items: texts
            .slice(offset, offset + size)
            .map((t, i) => toItem(t, offset + i)),
          nextCursor: next < texts.length ? String(next) : null,
        };
      } finally {
        inFlight--;
      }
    },
  );
  const write = jest.fn(async (): Promise<any> => {
    throw new Error("unexpected write call");
  });
  const api = {
    get,
    post: write,
    patch: write,
    delete: write,
  } as unknown as IntentApi;
  return {
    api,
    calls,
    write,
    peak: () => peak,
    listCalls: () => calls.filter((c) => c.path === LIST_PATH),
    singleCalls: () =>
      calls.filter((c) =>
        /^\/v2\.0\/flows\/[^/]+\/intents\/[^/]+$/.test(c.path),
      ),
    sentenceCalls: () => calls.filter((c) => c.path.endsWith("/sentences")),
  };
}

const okRead = (r: ReadResult): FlowIntents => {
  if (!r.ok) throw new Error(`expected ok result, got ${r.error}`);
  return r;
};

const COUNTS_OFF = { includeSentenceCounts: false };
const hasKey = (obj: unknown, key: string): boolean =>
  key in JSON.parse(JSON.stringify(obj));

// ---------------------------------------------------------------------------
// readFlowIntents: paging
// ---------------------------------------------------------------------------

describe("readFlowIntents paging", () => {
  it("exports the documented constants", () => {
    expect(LIST_PAGE_SIZE).toBe(100);
    expect(MAX_LIST_PAGES).toBe(20);
    expect(DEFAULT_CONCURRENCY).toBe(6);
    expect(MAX_EXISTING_PAGES).toBe(20);
  });

  it("requests page 1 with exactly limit 100 and includeChildren, and returns the whole result", async () => {
    const fake = makeFake({
      intents: [raw(1, "Alpha intent", null), raw(2, "Beta intent", null)],
    });
    const result = await readFlowIntents(fake.api, FLOW, COUNTS_OFF);
    expect(fake.calls).toEqual([
      { path: LIST_PATH, params: { limit: 100, includeChildren: true } },
    ]);
    expect(fake.write).not.toHaveBeenCalled();
    const tree = buildTree([
      { id: id(1), name: "Alpha intent", parentId: null },
      { id: id(2), name: "Beta intent", parentId: null },
    ]);
    expect(result).toEqual({
      ok: true,
      intents: [
        {
          id: id(1),
          name: "Alpha intent",
          parentId: null,
          childIds: [],
          depth: 1,
        },
        {
          id: id(2),
          name: "Beta intent",
          parentId: null,
          childIds: [],
          depth: 1,
        },
      ],
      total: 2,
      maxDepth: 1,
      tree,
      problems: [],
    });
  });

  it("follows nextCursor with exact params on pages 2 and 3 and keeps item order", async () => {
    const raws = [1, 2, 3, 4, 5].map((n) => raw(n, `Intent number ${n}`, null));
    const fake = makeFake({ intents: raws, pageSize: 2 });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.listCalls().map((c) => c.params)).toEqual([
      { limit: 100, includeChildren: true },
      { limit: 100, includeChildren: true, next: "2" },
      { limit: 100, includeChildren: true, next: "4" },
    ]);
    expect(result.intents.map((i) => i.id)).toEqual([1, 2, 3, 4, 5].map(id));
    expect(result.total).toBe(5);
    expect(hasKey(result, "truncated")).toBe(false);
  });

  it("sends includeFeedbackReport: true on every page only with includeStatus", async () => {
    const raws = [1, 2, 3].map((n) => raw(n, `Intent number ${n}`, null));
    const withStatus = makeFake({ intents: raws, pageSize: 2 });
    await readFlowIntents(withStatus.api, FLOW, {
      ...COUNTS_OFF,
      includeStatus: true,
    });
    expect(withStatus.listCalls().map((c) => c.params)).toEqual([
      { limit: 100, includeChildren: true, includeFeedbackReport: true },
      {
        limit: 100,
        includeChildren: true,
        includeFeedbackReport: true,
        next: "2",
      },
    ]);
    const without = makeFake({ intents: raws, pageSize: 2 });
    await readFlowIntents(without.api, FLOW, {
      ...COUNTS_OFF,
      includeStatus: false,
    });
    for (const c of without.listCalls()) {
      expect(Object.keys(c.params ?? {})).not.toContain(
        "includeFeedbackReport",
      );
    }
  });

  it("stops at 20 pages, sets truncated and never requests a 21st page", async () => {
    const fake = makeFake({
      list: async (_p, index) => ({
        items: [raw(index + 1, `Paged intent ${index + 1}`, null)],
        total: 500,
        nextCursor: `c${index}`,
      }),
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.listCalls()).toHaveLength(20);
    expect(fake.listCalls()[19].params).toEqual({
      limit: 100,
      includeChildren: true,
      next: "c18",
    });
    expect(result.intents).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
  });

  it("is not truncated when the 20th page is the last one", async () => {
    const fake = makeFake({
      list: async (_p, index) => ({
        items: [raw(index + 1, `Paged intent ${index + 1}`, null)],
        total: 20,
        nextCursor: index === 19 ? null : `c${index}`,
      }),
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.listCalls()).toHaveLength(20);
    expect(result.intents).toHaveLength(20);
    expect(hasKey(result, "truncated")).toBe(false);
  });

  it("stops with truncated when the same cursor comes back twice", async () => {
    const fake = makeFake({
      list: async (_p, index) => {
        if (index === 0)
          return {
            items: [raw(1, "First intent", null)],
            total: 9,
            nextCursor: "x",
          };
        if (index === 1)
          return { items: [raw(2, "Second intent", null)], nextCursor: "x" };
        return { items: [raw(3, "Third intent", null)], nextCursor: null };
      },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.listCalls()).toHaveLength(2);
    expect(result.intents.map((i) => i.id)).toEqual([id(1), id(2)]);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(9);
  });

  it("returns flow_not_readable with httpStatus when the first page rejects, with no other call", async () => {
    const fake = makeFake({
      list: async () => {
        throw upstreamError(403);
      },
    });
    const result = await readFlowIntents(fake.api, FLOW);
    expect(result).toEqual({
      ok: false,
      error: "flow_not_readable",
      httpStatus: 403,
    });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns flow_not_readable with httpStatus from a plain Error carrying a numeric status and no response", async () => {
    const fake = makeFake({
      list: async () => {
        throw clientError(401);
      },
    });
    const result = await readFlowIntents(fake.api, FLOW);
    expect(result).toEqual({
      ok: false,
      error: "flow_not_readable",
      httpStatus: 401,
    });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("prefers response.status over status when both are numeric", async () => {
    const fake = makeFake({
      list: async () => {
        throw Object.assign(new Error(SENTINEL_ERROR), {
          status: 500,
          response: { status: 429 },
        });
      },
    });
    expect(await readFlowIntents(fake.api, FLOW)).toEqual({
      ok: false,
      error: "flow_not_readable",
      httpStatus: 429,
    });
  });

  it("omits httpStatus when the status is not numeric", async () => {
    const fake = makeFake({
      list: async () => {
        throw Object.assign(new Error(SENTINEL_ERROR), { status: "503" });
      },
    });
    const result = await readFlowIntents(fake.api, FLOW);
    expect(result).toEqual({ ok: false, error: "flow_not_readable" });
    expect(hasKey(result, "httpStatus")).toBe(false);
  });

  it("returns flow_not_readable without httpStatus when the error has no response", async () => {
    const fake = makeFake({
      list: async () => {
        throw upstreamError();
      },
    });
    const result = await readFlowIntents(fake.api, FLOW);
    expect(result).toEqual({ ok: false, error: "flow_not_readable" });
    expect(hasKey(result, "httpStatus")).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("keeps earlier items and sets truncated when a later page rejects", async () => {
    const fake = makeFake({
      list: async (_p, index) => {
        if (index === 0)
          return {
            items: [raw(1, "Kept one", null), raw(2, "Kept two", null)],
            total: 5,
            nextCursor: "2",
          };
        throw upstreamError(503);
      },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.listCalls()).toHaveLength(2);
    expect(result.intents.map((i) => i.id)).toEqual([id(1), id(2)]);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(5);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("falls back to the number of items read when the first page total is not a number", async () => {
    const fake = makeFake({
      list: async (_p, index) =>
        index === 0
          ? {
              items: [raw(1, "One", null), raw(2, "Two", null)],
              total: "many",
              nextCursor: "a",
            }
          : { items: [raw(3, "Three", null)], nextCursor: null },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(result.total).toBe(3);
  });

  it("uses the total of the first page, not of later pages", async () => {
    const fake = makeFake({
      list: async (_p, index) =>
        index === 0
          ? { items: [raw(1, "One", null)], total: 7, nextCursor: "a" }
          : { items: [raw(2, "Two", null)], total: 99, nextCursor: null },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(result.total).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: tree and priority mapping
// ---------------------------------------------------------------------------

describe("readFlowIntents tree mapping", () => {
  it("maps parent ids, depth, childIds, priority, roots, orphans and maxDepth", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Root one", null, {
          biasTowardsParentOrChildIntents: "parents",
        }),
        raw(2, "Kid two", 1, { biasTowardsParentOrChildIntents: "children" }),
        raw(3, "Grand three", 2, {
          biasTowardsParentOrChildIntents: "Parents",
        }),
        raw(4, "Solo four", undefined, {
          biasTowardsParentOrChildIntents: null,
        }),
        raw(5, "Lost five", 9, { biasTowardsParentOrChildIntents: "sideways" }),
      ],
      childFeatures: { [id(1)]: true, [id(2)]: false },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(result.intents).toEqual([
      {
        id: id(1),
        name: "Root one",
        parentId: null,
        childIds: [id(2)],
        depth: 1,
        childFeatures: true,
        priority: "parents",
      },
      {
        id: id(2),
        name: "Kid two",
        parentId: id(1),
        childIds: [id(3)],
        depth: 2,
        childFeatures: false,
        priority: "children",
      },
      {
        id: id(3),
        name: "Grand three",
        parentId: id(2),
        childIds: [],
        depth: 3,
      },
      { id: id(4), name: "Solo four", parentId: null, childIds: [], depth: 1 },
      { id: id(5), name: "Lost five", parentId: id(9), childIds: [], depth: 0 },
    ]);
    expect(result.maxDepth).toBe(3);
    expect(result.problems).toEqual([{ id: id(5), problem: "orphan" }]);
    expect(result.tree.roots).toEqual([id(1), id(4)]);
    expect(result.tree.problems).toEqual([{ id: id(5), problem: "orphan" }]);
    expect(result.tree.maxDepth).toBe(3);
    expect(result.total).toBe(5);
  });

  it("treats a null and an absent parentIntentId both as root", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Null parent", null),
        raw(2, "Absent parent", undefined),
      ],
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(result.intents.map((i) => [i.parentId, i.depth])).toEqual([
      [null, 1],
      [null, 1],
    ]);
    expect(result.tree.roots).toEqual([id(1), id(2)]);
  });

  it("returns an empty flow as zero intents with maxDepth 0", async () => {
    const fake = makeFake({ intents: [] });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.maxDepth).toBe(0);
    expect(result.problems).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: childFeatures
// ---------------------------------------------------------------------------

describe("readFlowIntents childFeatures", () => {
  const family = [
    raw(1, "Parent one", null),
    raw(2, "Child two", 1),
    raw(3, "Parent three", null),
    raw(4, "Child four", 3),
    raw(5, "Leaf five", null),
  ];

  it("requests the single-intent GET only for intents that have children", async () => {
    const fake = makeFake({
      intents: family,
      childFeatures: { [id(1)]: true, [id(3)]: false },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(
      fake
        .singleCalls()
        .map((c) => c.path)
        .sort(),
    ).toEqual([singlePath(id(1)), singlePath(id(3))]);
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    expect(byId[id(1)].childFeatures).toBe(true);
    expect(byId[id(3)].childFeatures).toBe(false);
    for (const leaf of [id(2), id(4), id(5)]) {
      expect(hasKey(byId[leaf], "childFeatures")).toBe(false);
    }
    expect(hasKey(result, "countsIncomplete")).toBe(false);
  });

  it("leaves childFeatures out when the GET fails and does not throw, and sets countsIncomplete", async () => {
    const fake = makeFake({
      intents: family,
      childFeatures: { [id(3)]: true },
      failSingle: [id(1)],
      failStatus: 500,
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    expect(hasKey(byId[id(1)], "childFeatures")).toBe(false);
    expect(byId[id(3)].childFeatures).toBe(true);
    expect(result.countsIncomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("sets countsIncomplete when only a childFeatures GET fails and sentence counts succeed", async () => {
    const fake = makeFake({
      intents: [raw(1, "Parent one", null), raw(2, "Child two", 1)],
      sentenceTotals: { [id(1)]: 2, [id(2)]: 3 },
      failSingle: [id(1)],
      failStatus: 500,
      failShape: "status",
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      {
        id: id(1),
        name: "Parent one",
        parentId: null,
        childIds: [id(2)],
        depth: 1,
        sentenceCount: 2,
      },
      {
        id: id(2),
        name: "Child two",
        parentId: id(1),
        childIds: [],
        depth: 2,
        sentenceCount: 3,
      },
    ]);
    expect(result.countsIncomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("leaves childFeatures out when the value is not a boolean and sets countsIncomplete", async () => {
    const fake = makeFake({
      intents: family,
      childFeatures: { [id(1)]: "yes", [id(3)]: 1 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    expect(hasKey(byId[id(1)], "childFeatures")).toBe(false);
    expect(hasKey(byId[id(3)], "childFeatures")).toBe(false);
    expect(result.countsIncomplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: sentence counts
// ---------------------------------------------------------------------------

describe("readFlowIntents sentence counts", () => {
  const roots = [
    raw(1, "Count one", null),
    raw(2, "Count two", null),
    raw(3, "Count three", null),
  ];

  it("requests limit 1 for every intent and sets the exact totals", async () => {
    const fake = makeFake({
      intents: roots,
      sentenceTotals: { [id(1)]: 0, [id(2)]: 3, [id(3)]: 7 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(
      fake
        .sentenceCalls()
        .map((c) => [c.path, c.params])
        .sort(),
    ).toEqual([1, 2, 3].map((n) => [sentencesPath(id(n)), { limit: 1 }]));
    expect(result.intents.map((i) => i.sentenceCount)).toEqual([0, 3, 7]);
    expect(hasKey(result, "countsIncomplete")).toBe(false);
  });

  it("makes no sentences request when includeSentenceCounts is false", async () => {
    const fake = makeFake({ intents: roots, sentenceTotals: { [id(1)]: 4 } });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(fake.sentenceCalls()).toEqual([]);
    for (const i of result.intents)
      expect(hasKey(i, "sentenceCount")).toBe(false);
    expect(hasKey(result, "countsIncomplete")).toBe(false);
  });

  it("leaves a failed or non-numeric count out and sets countsIncomplete", async () => {
    const fake = makeFake({
      intents: roots,
      sentenceTotals: { [id(2)]: "5", [id(3)]: 6 },
      failSentences: [id(1)],
      failStatus: 502,
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents.map((i) => [i.id, i.sentenceCount])).toEqual([
      [id(1), undefined],
      [id(2), undefined],
      [id(3), 6],
    ]);
    expect(hasKey(result.intents[0], "sentenceCount")).toBe(false);
    expect(hasKey(result.intents[1], "sentenceCount")).toBe(false);
    expect(result.countsIncomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("puts sentenceCount and childFeatures on the same intent", async () => {
    const fake = makeFake({
      intents: [raw(1, "Parent one", null), raw(2, "Child two", 1)],
      childFeatures: { [id(1)]: false },
      sentenceTotals: { [id(1)]: 2, [id(2)]: 9 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      {
        id: id(1),
        name: "Parent one",
        parentId: null,
        childIds: [id(2)],
        depth: 1,
        childFeatures: false,
        sentenceCount: 2,
      },
      {
        id: id(2),
        name: "Child two",
        parentId: id(1),
        childIds: [],
        depth: 2,
        sentenceCount: 9,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: effective sentence counts
// ---------------------------------------------------------------------------

describe("readFlowIntents effectiveSentenceCount", () => {
  const sum = (
    n: number,
    name: string,
    parent: number | null,
    childIds: number[],
    depth: number,
    extra: Partial<IntentSummary> = {},
  ): IntentSummary => ({
    id: id(n),
    name,
    parentId: parent === null ? null : id(parent),
    childIds: childIds.map(id),
    depth,
    ...extra,
  });
  const billing = [
    raw(1, "Billing", null),
    raw(2, "Payments", 1),
    raw(3, "Card", 2),
    raw(4, "Bank", 2),
  ];

  it("adds children's counts up through inheriting parents (Billing > Payments > Card + Bank)", async () => {
    const fake = makeFake({
      intents: billing,
      childFeatures: { [id(1)]: true, [id(2)]: true },
      sentenceTotals: { [id(1)]: 0, [id(2)]: 0, [id(3)]: 6, [id(4)]: 6 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Billing", null, [2], 1, {
        childFeatures: true,
        sentenceCount: 0,
        effectiveSentenceCount: 12,
      }),
      sum(2, "Payments", 1, [3, 4], 2, {
        childFeatures: true,
        sentenceCount: 0,
        effectiveSentenceCount: 12,
      }),
      sum(3, "Card", 2, [], 3, { sentenceCount: 6 }),
      sum(4, "Bank", 2, [], 3, { sentenceCount: 6 }),
    ]);
    expect(hasKey(result, "countsIncomplete")).toBe(false);
  });

  it("gives no field to a parent with childFeatures false and does not pass its children up", async () => {
    const fake = makeFake({
      intents: billing,
      childFeatures: { [id(1)]: true, [id(2)]: false },
      sentenceTotals: { [id(1)]: 0, [id(2)]: 0, [id(3)]: 6, [id(4)]: 6 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Billing", null, [2], 1, {
        childFeatures: true,
        sentenceCount: 0,
        effectiveSentenceCount: 0,
      }),
      sum(2, "Payments", 1, [3, 4], 2, {
        childFeatures: false,
        sentenceCount: 0,
      }),
      sum(3, "Card", 2, [], 3, { sentenceCount: 6 }),
      sum(4, "Bank", 2, [], 3, { sentenceCount: 6 }),
    ]);
    expect(hasKey(result.intents[1], "effectiveSentenceCount")).toBe(false);
  });

  it("in a mixed chain the grandparent adds only the non-inheriting middle intent's own count", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Grand parent", null),
        raw(2, "Middle", 1),
        raw(3, "Deep leaf", 2),
        raw(4, "Side leaf", 1),
      ],
      childFeatures: { [id(1)]: true, [id(2)]: false },
      sentenceTotals: { [id(1)]: 1, [id(2)]: 2, [id(3)]: 5, [id(4)]: 3 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Grand parent", null, [2, 4], 1, {
        childFeatures: true,
        sentenceCount: 1,
        effectiveSentenceCount: 6,
      }),
      sum(2, "Middle", 1, [3], 2, { childFeatures: false, sentenceCount: 2 }),
      sum(3, "Deep leaf", 2, [], 3, { sentenceCount: 5 }),
      sum(4, "Side leaf", 1, [], 2, { sentenceCount: 3 }),
    ]);
  });

  it("adds a parent's own sentences to its children's (2 + 3 + 4 = 9)", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Own and kids", null),
        raw(2, "Kid a", 1),
        raw(3, "Kid b", 1),
      ],
      childFeatures: { [id(1)]: true },
      sentenceTotals: { [id(1)]: 2, [id(2)]: 3, [id(3)]: 4 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Own and kids", null, [2, 3], 1, {
        childFeatures: true,
        sentenceCount: 2,
        effectiveSentenceCount: 9,
      }),
      sum(2, "Kid a", 1, [], 2, { sentenceCount: 3 }),
      sum(3, "Kid b", 1, [], 2, { sentenceCount: 4 }),
    ]);
  });

  it("never gives a leaf the field", async () => {
    const fake = makeFake({
      intents: [raw(1, "Leaf one", null), raw(2, "Leaf two", null)],
      sentenceTotals: { [id(1)]: 8, [id(2)]: 1 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Leaf one", null, [], 1, { sentenceCount: 8 }),
      sum(2, "Leaf two", null, [], 1, { sentenceCount: 1 }),
    ]);
    for (const i of result.intents)
      expect(hasKey(i, "effectiveSentenceCount")).toBe(false);
  });

  it("gives no field at all with includeSentenceCounts false", async () => {
    const fake = makeFake({
      intents: billing,
      childFeatures: { [id(1)]: true, [id(2)]: true },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    expect(result.intents).toEqual([
      sum(1, "Billing", null, [2], 1, { childFeatures: true }),
      sum(2, "Payments", 1, [3, 4], 2, { childFeatures: true }),
      sum(3, "Card", 2, [], 3),
      sum(4, "Bank", 2, [], 3),
    ]);
    for (const i of result.intents)
      expect(hasKey(i, "effectiveSentenceCount")).toBe(false);
  });

  it("leaves the field out where a needed child count is missing, keeps the others, and sets countsIncomplete", async () => {
    const fake = makeFake({
      intents: [...billing, raw(5, "Other", null), raw(6, "Other kid", 5)],
      childFeatures: { [id(1)]: true, [id(2)]: true, [id(5)]: true },
      sentenceTotals: {
        [id(1)]: 0,
        [id(2)]: 0,
        [id(4)]: 6,
        [id(5)]: 1,
        [id(6)]: 2,
      },
      failSentences: [id(3)],
      failStatus: 500,
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Billing", null, [2], 1, {
        childFeatures: true,
        sentenceCount: 0,
      }),
      sum(2, "Payments", 1, [3, 4], 2, {
        childFeatures: true,
        sentenceCount: 0,
      }),
      sum(3, "Card", 2, [], 3),
      sum(4, "Bank", 2, [], 3, { sentenceCount: 6 }),
      sum(5, "Other", null, [6], 1, {
        childFeatures: true,
        sentenceCount: 1,
        effectiveSentenceCount: 3,
      }),
      sum(6, "Other kid", 5, [], 2, { sentenceCount: 2 }),
    ]);
    expect(result.countsIncomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("leaves the field out when the parent's own count is missing", async () => {
    const fake = makeFake({
      intents: [raw(1, "Parent", null), raw(2, "Kid", 1)],
      childFeatures: { [id(1)]: true },
      sentenceTotals: { [id(1)]: "n/a", [id(2)]: 4 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Parent", null, [2], 1, { childFeatures: true }),
      sum(2, "Kid", 1, [], 2, { sentenceCount: 4 }),
    ]);
    expect(result.countsIncomplete).toBe(true);
  });

  it("survives a two-intent cycle: no field on its members, healthy root keeps its value", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Cycle a", 2),
        raw(2, "Cycle b", 1),
        raw(3, "Healthy root", null),
        raw(4, "Healthy leaf", 3),
      ],
      childFeatures: { [id(1)]: true, [id(2)]: true, [id(3)]: true },
      sentenceTotals: { [id(1)]: 2, [id(2)]: 3, [id(3)]: 1, [id(4)]: 4 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.problems).toEqual([
      { id: id(1), problem: "cycle" },
      { id: id(2), problem: "cycle" },
    ]);
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    expect(hasKey(byId[id(1)], "effectiveSentenceCount")).toBe(false);
    expect(hasKey(byId[id(2)], "effectiveSentenceCount")).toBe(false);
    expect(byId[id(1)].sentenceCount).toBe(2);
    expect(byId[id(2)].sentenceCount).toBe(3);
    expect(byId[id(3)]).toEqual(
      sum(3, "Healthy root", null, [4], 1, {
        childFeatures: true,
        sentenceCount: 1,
        effectiveSentenceCount: 5,
      }),
    );
    expect(byId[id(4)]).toEqual(
      sum(4, "Healthy leaf", 3, [], 2, { sentenceCount: 4 }),
    );
  });

  it("survives an intent that is its own parent", async () => {
    const fake = makeFake({
      intents: [raw(1, "Self parent", 1), raw(2, "Healthy root", null)],
      childFeatures: { [id(1)]: true },
      sentenceTotals: { [id(1)]: 2, [id(2)]: 6 },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.problems).toEqual([{ id: id(1), problem: "cycle" }]);
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    expect(hasKey(byId[id(1)], "effectiveSentenceCount")).toBe(false);
    expect(byId[id(1)].sentenceCount).toBe(2);
    expect(byId[id(1)].depth).toBe(0);
    expect(byId[id(2)]).toEqual(
      sum(2, "Healthy root", null, [], 1, { sentenceCount: 6 }),
    );
  });

  it("survives a cycle three intents long", async () => {
    const fake = makeFake({
      intents: [
        raw(1, "Ring a", 3),
        raw(2, "Ring b", 1),
        raw(3, "Ring c", 2),
        raw(4, "Healthy root", null),
        raw(5, "Healthy leaf", 4),
      ],
      childFeatures: {
        [id(1)]: true,
        [id(2)]: true,
        [id(3)]: true,
        [id(4)]: true,
      },
      sentenceTotals: {
        [id(1)]: 1,
        [id(2)]: 2,
        [id(3)]: 3,
        [id(4)]: 0,
        [id(5)]: 7,
      },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.problems).toEqual([
      { id: id(1), problem: "cycle" },
      { id: id(2), problem: "cycle" },
      { id: id(3), problem: "cycle" },
    ]);
    const byId = Object.fromEntries(result.intents.map((i) => [i.id, i]));
    for (const n of [1, 2, 3]) {
      expect(hasKey(byId[id(n)], "effectiveSentenceCount")).toBe(false);
      expect(byId[id(n)].depth).toBe(0);
    }
    expect(byId[id(4)]).toEqual(
      sum(4, "Healthy root", null, [5], 1, {
        childFeatures: true,
        sentenceCount: 0,
        effectiveSentenceCount: 7,
      }),
    );
  });

  it("gives no field when childFeatures is unknown because the lookup failed", async () => {
    const fake = makeFake({
      intents: [raw(1, "Parent", null), raw(2, "Kid", 1)],
      sentenceTotals: { [id(1)]: 2, [id(2)]: 4 },
      failSingle: [id(1)],
      failStatus: 500,
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents).toEqual([
      sum(1, "Parent", null, [2], 1, { sentenceCount: 2 }),
      sum(2, "Kid", 1, [], 2, { sentenceCount: 4 }),
    ]);
    expect(result.countsIncomplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: concurrency
// ---------------------------------------------------------------------------

describe("readFlowIntents concurrency", () => {
  const twenty = Array.from({ length: 20 }, (_, i) =>
    raw(i + 1, `Parallel intent ${i + 1}`, null),
  );

  it("never has more than 6 requests in flight by default, and reaches 6", async () => {
    const fake = makeFake({ intents: twenty });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(fake.sentenceCalls()).toHaveLength(20);
    expect(fake.peak()).toBe(6);
    expect(result.intents.every((i) => i.sentenceCount === 0)).toBe(true);
  });

  it("honours a custom concurrency of 2 exactly", async () => {
    const fake = makeFake({ intents: twenty });
    await readFlowIntents(fake.api, FLOW, { concurrency: 2 });
    expect(fake.sentenceCalls()).toHaveLength(20);
    expect(fake.peak()).toBe(2);
  });

  it("shares the limit between childFeatures and sentence-count requests", async () => {
    const intents: RawIntent[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        raw(i + 1, `Parent ${i + 1}`, null),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        raw(i + 9, `Child ${i + 1}`, i + 1),
      ),
    ];
    const fake = makeFake({ intents });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(
      fake
        .singleCalls()
        .map((c) => c.path)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => singlePath(id(n))));
    expect(fake.sentenceCalls()).toHaveLength(16);
    expect(fake.peak()).toBe(6);
    expect(result.intents.filter((i) => i.childFeatures === true)).toHaveLength(
      8,
    );
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: deadline
// ---------------------------------------------------------------------------

describe("readFlowIntents deadline", () => {
  it("stops starting requests once the injected clock passes the deadline", async () => {
    let t = 0;
    const roots = [1, 2, 3, 4, 5].map((n) => raw(n, `Timed intent ${n}`, null));
    const fake = makeFake({
      intents: roots,
      sentenceTotals: {
        [id(1)]: 3,
        [id(2)]: 4,
        [id(3)]: 5,
        [id(4)]: 6,
        [id(5)]: 7,
      },
      afterSentenceCount: () => {
        t += 60;
      },
    });
    const result = okRead(
      await readFlowIntents(fake.api, FLOW, {
        concurrency: 1,
        deadlineMs: 100,
        now: () => t,
      }),
    );
    // start 0 -> request 1 (t=60) -> request 2 (t=120) -> deadline reached
    expect(fake.sentenceCalls()).toHaveLength(2);
    const requested = fake.sentenceCalls().map((c) => c.path);
    expect(requested).toEqual([sentencesPath(id(1)), sentencesPath(id(2))]);
    expect(result.intents.map((i) => i.sentenceCount)).toEqual([
      3,
      4,
      undefined,
      undefined,
      undefined,
    ]);
    expect(hasKey(result.intents[2], "sentenceCount")).toBe(false);
    expect(result.countsIncomplete).toBe(true);
  });

  it("still reads every list page when the deadline is already over", async () => {
    const roots = [1, 2, 3, 4, 5].map((n) => raw(n, `Late intent ${n}`, null));
    const fake = makeFake({ intents: roots, pageSize: 2 });
    const result = okRead(
      await readFlowIntents(fake.api, FLOW, { deadlineMs: 0, now: () => 0 }),
    );
    expect(fake.listCalls()).toHaveLength(3);
    expect(fake.singleCalls()).toEqual([]);
    expect(fake.sentenceCalls()).toEqual([]);
    expect(result.intents).toHaveLength(5);
    expect(result.countsIncomplete).toBe(true);
    for (const i of result.intents)
      expect(hasKey(i, "sentenceCount")).toBe(false);
  });

  it("starts no request when the clock passes the deadline during list paging", async () => {
    let t = 0;
    const roots = [1, 2, 3].map((n) => raw(n, `Slow list intent ${n}`, null));
    const fake = makeFake({
      intents: roots,
      pageSize: 1,
      afterList: () => {
        t += 100;
      },
    });
    const result = okRead(
      await readFlowIntents(fake.api, FLOW, { deadlineMs: 50, now: () => t }),
    );
    expect(fake.listCalls()).toHaveLength(3);
    expect(fake.sentenceCalls()).toEqual([]);
    expect(result.countsIncomplete).toBe(true);
  });

  it("sets countsIncomplete when the deadline skips only childFeatures requests", async () => {
    const fake = makeFake({
      intents: [raw(1, "Parent one", null), raw(2, "Child two", 1)],
    });
    const result = okRead(
      await readFlowIntents(fake.api, FLOW, {
        includeSentenceCounts: false,
        deadlineMs: 0,
        now: () => 0,
      }),
    );
    expect(fake.singleCalls()).toEqual([]);
    expect(fake.sentenceCalls()).toEqual([]);
    expect(result.intents).toEqual([
      {
        id: id(1),
        name: "Parent one",
        parentId: null,
        childIds: [id(2)],
        depth: 1,
      },
      { id: id(2), name: "Child two", parentId: id(1), childIds: [], depth: 2 },
    ]);
    expect(result.countsIncomplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFlowIntents: status
// ---------------------------------------------------------------------------

describe("readFlowIntents status", () => {
  const fr = (findings: unknown) => ({ feedbackReport: { findings } });
  const listed = (...pairs: Array<[string, number]>) =>
    pairs.map(([intentName, n]) => ({ intentName, intentId: id(n) }));
  const statusIntents = [
    raw(1, "No report", null),
    raw(2, "Empty findings", null, fr([])),
    raw(8, "Missing findings", null, { feedbackReport: {} }),
    raw(
      3,
      "Own low data",
      null,
      fr([
        {
          type: "lowDataIntents",
          intents: listed(["Zulu low", 3], ["Alpha low", 4]),
        },
      ]),
    ),
    raw(
      4,
      "Other low data",
      null,
      fr([{ type: "lowDataIntents", intents: listed(["Zulu low", 3]) }]),
    ),
    raw(
      5,
      "Unknown type",
      null,
      fr([
        {
          type: "somethingNew",
          intents: listed(["Echo name", 5], ["Foxtrot name", 6]),
        },
      ]),
    ),
    raw(
      6,
      "Mixed",
      null,
      fr([
        { type: "lowDataIntents", intents: listed(["Golf name", 7]) },
        { type: "lowDataIntents", intents: listed(["Hotel name", 6]) },
      ]),
    ),
    raw(
      7,
      "Unknown then other",
      null,
      fr([
        { type: "somethingNew", intents: listed(["India name", 7]) },
        {
          type: "lowDataIntents",
          intents: listed(["Juliet name", 6], ["Kilo name", 1]),
        },
      ]),
    ),
  ];

  it("maps every status branch with exact reasons in order", async () => {
    const fake = makeFake({ intents: statusIntents });
    const result = okRead(
      await readFlowIntents(fake.api, FLOW, {
        ...COUNTS_OFF,
        includeStatus: true,
      }),
    );
    expect(result.intents.map((i) => i.status)).toEqual([
      { state: "unknown", reasons: [] },
      { state: "ok", reasons: [] },
      { state: "ok", reasons: [] },
      {
        state: "low_data",
        reasons: [
          { type: "lowDataIntents", intents: ["Zulu low", "Alpha low"] },
        ],
      },
      {
        state: "not_scored",
        reasons: [{ type: "lowDataIntents", intents: ["Zulu low"] }],
      },
      {
        state: "ok",
        reasons: [
          { type: "somethingNew", intents: ["Echo name", "Foxtrot name"] },
        ],
      },
      {
        state: "low_data",
        reasons: [
          { type: "lowDataIntents", intents: ["Golf name"] },
          { type: "lowDataIntents", intents: ["Hotel name"] },
        ],
      },
      {
        state: "not_scored",
        reasons: [
          { type: "somethingNew", intents: ["India name"] },
          { type: "lowDataIntents", intents: ["Juliet name", "Kilo name"] },
        ],
      },
    ]);
  });

  it("has no status field and sends no feedback param without includeStatus", async () => {
    const fake = makeFake({ intents: statusIntents });
    const result = okRead(await readFlowIntents(fake.api, FLOW, COUNTS_OFF));
    for (const i of result.intents) expect(hasKey(i, "status")).toBe(false);
    expect(Object.keys(fake.listCalls()[0].params ?? {}).sort()).toEqual([
      "includeChildren",
      "limit",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("never returns sentence text from readFlowIntents or exportTree", async () => {
    const fake = makeFake({
      intents: [raw(1, "Private one", null), raw(2, "Private two", null)],
      sentenceTexts: {
        [id(1)]: [SENTINEL_SENTENCE, "alpha sample one"],
        [id(2)]: [SENTINEL_SENTENCE],
      },
    });
    const result = okRead(await readFlowIntents(fake.api, FLOW));
    expect(result.intents.map((i) => i.sentenceCount)).toEqual([2, 1]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
    expect(JSON.stringify(result)).not.toContain("alpha sample one");
    expect(JSON.stringify(exportTree(FLOW, result))).not.toContain(
      SENTINEL_SENTENCE,
    );
  });
});

// ---------------------------------------------------------------------------
// getIntent
// ---------------------------------------------------------------------------

describe("getIntent", () => {
  const inputs: IntentInput[] = [
    { id: id(1), name: "Root alpha", parentId: null, priority: "parents" },
    { id: id(2), name: "Kid beta", parentId: id(1), priority: "children" },
    { id: id(3), name: "Grand gamma", parentId: id(2) },
    { id: id(4), name: "Twin", parentId: null },
    { id: id(5), name: "Twin", parentId: null },
  ];
  const tree: IntentTree = buildTree(inputs);
  const rootSummary: IntentSummary = {
    id: id(1),
    name: "Root alpha",
    parentId: null,
    childIds: [id(2)],
    depth: 1,
    priority: "parents",
    childFeatures: true,
    sentenceCount: 4,
  };
  const serveRoot = () =>
    makeFake({
      childFeatures: { [id(1)]: true, [id(2)]: false, [id(3)]: false },
      sentenceTotals: { [id(1)]: 4, [id(2)]: 1, [id(3)]: 0 },
      sentenceTexts: {
        [id(1)]: [
          SENTINEL_SENTENCE,
          "alpha sample one",
          "beta sample two",
          "gamma sample three",
        ],
      },
    });

  it("returns not_found with zero api calls", async () => {
    const fake = serveRoot();
    expect(await getIntent(fake.api, FLOW, tree, "Missing name")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(fake.calls).toEqual([]);
  });

  it("returns ambiguous with candidates in input order and zero api calls", async () => {
    const fake = serveRoot();
    expect(await getIntent(fake.api, FLOW, tree, "Twin")).toEqual({
      ok: false,
      error: "ambiguous",
      candidates: [id(4), id(5)],
    });
    expect(fake.calls).toEqual([]);
  });

  it("resolves by id with exactly the two documented GETs", async () => {
    const fake = serveRoot();
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({ ok: true, intent: rootSummary });
    expect(fake.calls.map((c) => c.path).sort()).toEqual(
      [singlePath(id(1)), sentencesPath(id(1))].sort(),
    );
    expect(fake.sentenceCalls()[0].params).toEqual({ limit: 1 });
    expect(hasKey(result, "sentences")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
  });

  it("resolves by name and by path to the same intent", async () => {
    const byName = serveRoot();
    expect(await getIntent(byName.api, FLOW, tree, "Root alpha")).toEqual({
      ok: true,
      intent: rootSummary,
    });
    const byPath = serveRoot();
    const result = await getIntent(
      byPath.api,
      FLOW,
      tree,
      "Root alpha/Kid beta/Grand gamma",
    );
    expect(result).toEqual({
      ok: true,
      intent: {
        id: id(3),
        name: "Grand gamma",
        parentId: id(2),
        childIds: [],
        depth: 3,
        childFeatures: false,
        sentenceCount: 0,
      },
    });
    expect(byPath.calls.map((c) => c.path).sort()).toEqual(
      [singlePath(id(3)), sentencesPath(id(3))].sort(),
    );
  });

  it("copies childFeatures false and the numeric sentence total for a child", async () => {
    const fake = serveRoot();
    const result = await getIntent(fake.api, FLOW, tree, id(2));
    expect(result).toEqual({
      ok: true,
      intent: {
        id: id(2),
        name: "Kid beta",
        parentId: id(1),
        childIds: [id(3)],
        depth: 2,
        priority: "children",
        childFeatures: false,
        sentenceCount: 1,
      },
    });
  });

  it("returns trimmed sentences in platform order following the cursor", async () => {
    const fake = makeFake({
      childFeatures: { [id(1)]: true },
      sentenceTexts: {
        [id(1)]: [
          "  zeta one ",
          "alpha two",
          "mid three",
          "beta four ",
          "  omega five",
        ],
      },
      sentencePageSize: 2,
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: true,
      intent: { ...rootSummary, sentenceCount: 5 },
      sentences: [
        "zeta one",
        "alpha two",
        "mid three",
        "beta four",
        "omega five",
      ],
    });
    expect(
      fake
        .sentenceCalls()
        .filter((c) => c.params?.limit === 100)
        .map((c) => c.params),
    ).toEqual([
      { limit: 100 },
      { limit: 100, next: "2" },
      { limit: 100, next: "4" },
    ]);
    expect(
      fake.sentenceCalls().filter((c) => c.params?.limit === 1),
    ).toHaveLength(1);
  });

  it("omits sentences and makes no limit-100 request without includeSentences", async () => {
    const fake = serveRoot();
    const result = await getIntent(fake.api, FLOW, tree, id(1), {});
    expect(hasKey(result, "sentences")).toBe(false);
    expect(fake.sentenceCalls().filter((c) => c.params?.limit === 100)).toEqual(
      [],
    );
    expect(fake.calls).toHaveLength(2);
  });

  it("requests at most MAX_EXISTING_PAGES sentence pages", async () => {
    const fake = makeFake({
      sentenceList: async (_id, _p, index) => ({
        items: [{ _id: `s${index}`, text: `sample ${index}` }],
        nextCursor: `c${index}`,
      }),
    });
    await getIntent(fake.api, FLOW, tree, id(1), { includeSentences: true });
    expect(
      fake.sentenceCalls().filter((c) => c.params?.limit === 100),
    ).toHaveLength(MAX_EXISTING_PAGES);
  });

  it("returns the sentences read so far with sentencesTruncated when the 20-page limit is hit with a cursor still present", async () => {
    const fake = makeFake({
      sentenceTotals: { [id(1)]: 4 },
      sentenceList: async (_id, _p, index) => ({
        items: [{ _id: `s${index}`, text: `sample ${index}` }],
        nextCursor: `c${index}`,
      }),
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: true,
      intent: rootSummary,
      sentences: Array.from({ length: 20 }, (_, i) => `sample ${i}`),
      sentencesTruncated: true,
    });
    expect(
      fake.sentenceCalls().filter((c) => c.params?.limit === 100),
    ).toHaveLength(20);
  });

  it("has no sentencesTruncated when the 20th page is the last one", async () => {
    const fake = makeFake({
      sentenceTotals: { [id(1)]: 4 },
      sentenceList: async (_id, _p, index) => ({
        items: [{ _id: `s${index}`, text: `sample ${index}` }],
        nextCursor: index === 19 ? null : `c${index}`,
      }),
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: true,
      intent: rootSummary,
      sentences: Array.from({ length: 20 }, (_, i) => `sample ${i}`),
    });
    expect(hasKey(result, "sentencesTruncated")).toBe(false);
  });

  it("has no sentencesTruncated when the sentences end before the limit", async () => {
    const fake = makeFake({
      sentenceTotals: { [id(1)]: 4 },
      sentenceTexts: { [id(1)]: ["one a", "two b", "three c"] },
      sentencePageSize: 2,
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: true,
      intent: rootSummary,
      sentences: ["one a", "two b", "three c"],
    });
    expect(hasKey(result, "sentencesTruncated")).toBe(false);
  });

  it("returns request_failed with httpStatus and no upstream text when the intent GET rejects", async () => {
    const fake = makeFake({ failSingle: [id(1)], failStatus: 500 });
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 500,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns request_failed with httpStatus from a plain Error carrying status and no response (intent GET)", async () => {
    const fake = makeFake({
      failSingle: [id(1)],
      failStatus: 503,
      failShape: "status",
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 503,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns request_failed with httpStatus from a plain Error carrying status (sentence count GET)", async () => {
    const fake = makeFake({
      failSentences: [id(1)],
      failStatus: 429,
      failShape: "status",
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 429,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns request_failed with httpStatus from a plain Error carrying status (sentence page)", async () => {
    const fake = makeFake({
      sentenceList: async () => {
        throw clientError(504);
      },
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 504,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns request_failed when the sentence count GET rejects", async () => {
    const fake = makeFake({ failSentences: [id(1)], failStatus: 404 });
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 404,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("returns request_failed when a sentence page rejects", async () => {
    const fake = makeFake({
      sentenceList: async () => {
        throw upstreamError(502);
      },
    });
    const result = await getIntent(fake.api, FLOW, tree, id(1), {
      includeSentences: true,
    });
    expect(result).toEqual({
      ok: false,
      error: "request_failed",
      httpStatus: 502,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERROR);
  });

  it("omits httpStatus from request_failed when the error has no response", async () => {
    const fake = makeFake({ failSingle: [id(1)] });
    const result = await getIntent(fake.api, FLOW, tree, id(1));
    expect(result).toEqual({ ok: false, error: "request_failed" });
    expect(hasKey(result, "httpStatus")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exportTree
// ---------------------------------------------------------------------------

describe("exportTree", () => {
  const inputs: IntentInput[] = [
    { id: id(1), name: "Zed", parentId: null },
    { id: id(2), name: "Alpha", parentId: id(1) },
    { id: id(3), name: "Orphan", parentId: id(9) },
  ];
  const tree = buildTree(inputs);
  const intents: IntentSummary[] = [
    {
      id: id(1),
      name: "Zed",
      parentId: null,
      childIds: [id(2)],
      depth: 1,
      childFeatures: false,
      priority: "parents",
      sentenceCount: 0,
      status: { state: "ok", reasons: [] },
    },
    {
      id: id(2),
      name: "Alpha",
      parentId: id(1),
      childIds: [],
      depth: 2,
      sentenceCount: 7,
    },
    { id: id(3), name: "Orphan", parentId: id(9), childIds: [], depth: 0 },
  ];
  const read = (extra: Partial<FlowIntents> = {}): FlowIntents => ({
    ok: true,
    intents,
    total: 3,
    maxDepth: 2,
    tree,
    problems: tree.problems,
    ...extra,
  });

  it("maps to the compact form, keeps order and omits absent optional fields", () => {
    expect(exportTree(FLOW, read())).toStrictEqual({
      flowId: FLOW,
      total: 3,
      maxDepth: 2,
      intents: [
        {
          id: id(1),
          name: "Zed",
          parentId: null,
          depth: 1,
          childFeatures: false,
          priority: "parents",
          sentenceCount: 0,
        },
        {
          id: id(2),
          name: "Alpha",
          parentId: id(1),
          depth: 2,
          sentenceCount: 7,
        },
        { id: id(3), name: "Orphan", parentId: id(9), depth: 0 },
      ],
    });
  });

  it("copies effectiveSentenceCount when present and omits it otherwise", () => {
    const withEffective: IntentSummary[] = [
      {
        id: id(1),
        name: "Parent",
        parentId: null,
        childIds: [id(2)],
        depth: 1,
        childFeatures: true,
        sentenceCount: 0,
        effectiveSentenceCount: 12,
      },
      {
        id: id(2),
        name: "Leaf",
        parentId: id(1),
        childIds: [],
        depth: 2,
        sentenceCount: 12,
      },
    ];
    expect(
      exportTree(FLOW, read({ intents: withEffective, total: 2 })),
    ).toStrictEqual({
      flowId: FLOW,
      total: 2,
      maxDepth: 2,
      intents: [
        {
          id: id(1),
          name: "Parent",
          parentId: null,
          depth: 1,
          childFeatures: true,
          sentenceCount: 0,
          effectiveSentenceCount: 12,
        },
        {
          id: id(2),
          name: "Leaf",
          parentId: id(1),
          depth: 2,
          sentenceCount: 12,
        },
      ],
    });
    expect(
      exportTree(FLOW, read()).intents.some((i) =>
        hasKey(i, "effectiveSentenceCount"),
      ),
    ).toBe(false);
  });

  it("includes truncated only when it is true", () => {
    expect(exportTree(FLOW, read({ truncated: true })).truncated).toBe(true);
    expect(hasKey(exportTree(FLOW, read()), "truncated")).toBe(false);
  });

  it("does not export countsIncomplete, childIds, status, tree or problems", () => {
    const out = exportTree(FLOW, read({ countsIncomplete: true }));
    expect(Object.keys(out).sort()).toEqual([
      "flowId",
      "intents",
      "maxDepth",
      "total",
    ]);
    for (const i of out.intents) {
      expect(Object.keys(i)).not.toContain("childIds");
      expect(Object.keys(i)).not.toContain("status");
    }
  });
});
