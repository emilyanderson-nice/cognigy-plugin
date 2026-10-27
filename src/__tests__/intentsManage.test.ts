import { describe, it, expect, jest } from "@jest/globals";
import { handleManageIntents } from "../tools/intents/manage.js";
import { FileAccessError } from "../utils/fileAccess.js";

// ---------------------------------------------------------------------------
// Synthetic ids (24 lowercase hex characters)
// ---------------------------------------------------------------------------
const hid = (c: string, n: number): string =>
  c.repeat(20) + String(n).padStart(4, "0");

const FLOW = hid("f", 1);
const PROJECT = hid("e", 1);
const LOC = hid("c", 1);
const TASK = hid("7", 1);
const FAM = hid("a", 1);
const GRP = hid("a", 2);
const TAG = hid("a", 3);
const OTH = hid("a", 4);
const DUP1 = hid("a", 5);
const DUP2 = hid("a", 6);
const LOST = hid("b", 1);
const MISSING_PARENT = hid("9", 9);
const NEW1 = hid("d", 1);

const SECRET = "UPSTREAM-SECRET-MSG-7731";
const SENTINEL = "zzsentinel";

const LIST_PATH = `/v2.0/flows/${FLOW}/intents`;
const FLOW_PATH = `/v2.0/flows/${FLOW}`;
const TRAIN_PATH = `/v2.0/flows/${FLOW}/intents/train`;
const intentPath = (id: string) => `/v2.0/flows/${FLOW}/intents/${id}`;
const sentPath = (id: string) => `/v2.0/flows/${FLOW}/intents/${id}/sentences`;
const taskPath = (id: string) => `/new/v2.0/tasks/${id}`;

// ---------------------------------------------------------------------------
// In-memory fake platform
// ---------------------------------------------------------------------------
type Method = "get" | "post" | "patch" | "delete";
interface Call {
  method: Method;
  path: string;
  params?: any;
  body?: any;
}
interface SeedIntent {
  id: string;
  name: string;
  parent?: string | null;
  childFeatures?: boolean;
  priority?: "parents" | "children";
  sentences?: string[];
  feedbackReport?: any;
}
interface Failure {
  method: Method;
  path: RegExp;
  status?: unknown;
  // "response": err.response.status (default); "plain": err.status and no
  // response (the real client's shape); "both": response 500-style status
  // wins over a conflicting err.status of 404.
  shape?: "response" | "plain" | "both";
  times?: number;
  when?: (c: Call) => boolean;
}
interface PlatformOptions {
  intents?: SeedIntent[];
  pageSize?: number;
  locale?: string | null;
  outOfDate?: boolean | null;
  // flow.projectReference: default PROJECT; null leaves it out
  projectRef?: string | null;
}

function defaultSeed(): SeedIntent[] {
  return [
    {
      id: FAM,
      name: "Family",
      parent: null,
      childFeatures: true,
      priority: "children",
      sentences: [1, 2, 3, 4, 5, 6].map((n) => `${SENTINEL} fam ${n}`),
    },
    {
      id: GRP,
      name: "Group",
      parent: FAM,
      childFeatures: true,
      sentences: [
        `${SENTINEL} grp 1`,
        `${SENTINEL} grp 2 `,
        `${SENTINEL} grp 3`,
      ],
    },
    {
      id: TAG,
      name: "Tag",
      parent: GRP,
      childFeatures: false,
      sentences: [1, 2, 3, 4, 5].map((n) => `${SENTINEL} tag ${n}`),
    },
    {
      id: OTH,
      name: "Other",
      parent: null,
      childFeatures: false,
      sentences: [],
    },
  ];
}

const dupSeeds = (): SeedIntent[] => [
  { id: DUP1, name: "Dup", parent: null, sentences: [] },
  { id: DUP2, name: "Dup", parent: null, sentences: [] },
];

function makePlatform(opts: PlatformOptions = {}) {
  let sentenceSeq = 0;
  let intentSeq = 0;
  const mkSentence = (text: string) => ({ _id: hid("5", ++sentenceSeq), text });
  const intents = (opts.intents ?? defaultSeed()).map((s) => ({
    id: s.id,
    name: s.name,
    parent: s.parent ?? null,
    childFeatures: s.childFeatures,
    priority: s.priority,
    feedbackReport: s.feedbackReport,
    sentences: (s.sentences ?? []).map(mkSentence),
  }));
  const calls: Call[] = [];
  const failures: Failure[] = [];
  const pageSize = opts.pageSize ?? 100;
  const locale = opts.locale === undefined ? LOC : opts.locale;
  let taskStatuses: string[] = ["done"];

  const find = (id: string) => {
    const r = intents.find((i) => i.id === id);
    if (!r) throw new Error(`fake: no intent ${id}`);
    return r;
  };
  const page = <T>(all: T[], params: any) => {
    const limit = Math.min(Number(params?.limit ?? 100), pageSize);
    const start = params?.next === undefined ? 0 : Number(params.next);
    const items = all.slice(start, start + limit);
    const end = start + items.length;
    return {
      items,
      total: all.length,
      nextCursor: end < all.length ? String(end) : null,
    };
  };

  const route = (c: Call): any => {
    const { method, path, params, body } = c;
    if (method === "get" && path === FLOW_PATH) {
      const flow: any = { _id: FLOW, isTrainingOutOfDate: opts.outOfDate };
      if (locale !== null) flow.localeReference = locale;
      const ref = opts.projectRef === undefined ? PROJECT : opts.projectRef;
      if (ref !== null) flow.projectReference = ref;
      return flow;
    }
    if (method === "get" && path === LIST_PATH) {
      const all = intents.filter(
        (i) => params?.includeChildren === true || i.parent === null,
      );
      const p = page(all, params);
      return {
        ...p,
        items: p.items.map((i) => {
          const it: any = {
            _id: i.id,
            name: i.name,
            parentIntentId: i.parent,
          };
          if (i.priority) it.biasTowardsParentOrChildIntents = i.priority;
          if (params?.includeFeedbackReport === true && i.feedbackReport) {
            it.feedbackReport = i.feedbackReport;
          }
          return it;
        }),
      };
    }
    if (method === "post" && path === LIST_PATH) {
      // The real platform answers 400 "Field 'localeReference' is not allowed".
      if (body && "localeReference" in body) {
        throw Object.assign(new Error(SECRET), { status: 400 });
      }
      const id = hid("d", ++intentSeq);
      intents.push({
        id,
        name: body.name,
        parent: body.parentIntentId ?? null,
        childFeatures: body.childFeatures,
        priority: body.biasTowardsParentOrChildIntents,
        feedbackReport: undefined,
        sentences: [],
      });
      return { _id: id };
    }
    if (method === "post" && path === TRAIN_PATH) {
      return {
        _id: TASK,
        status: "queued",
        currentStep: 0,
        totalStep: 3,
      };
    }
    let m = path.match(/^\/new\/v2\.0\/tasks\/(.+)$/);
    if (method === "get" && m) {
      const status =
        taskStatuses.length > 1 ? taskStatuses.shift()! : taskStatuses[0];
      return {
        _id: m[1],
        status,
        currentStep: 1,
        totalStep: 3,
        failReason: status === "error" ? SECRET : undefined,
      };
    }
    m = path.match(
      new RegExp(`^/v2\\.0/flows/${FLOW}/intents/([0-9a-f]{24})/sentences$`),
    );
    if (m) {
      const rec = find(m[1]);
      if (method === "get") return page(rec.sentences, params);
      if (method === "patch") {
        for (const op of body.operations) {
          if (op.op === "create") rec.sentences.push(mkSentence(op.value.text));
          else if (op.op === "delete") {
            rec.sentences = rec.sentences.filter((s) => s._id !== op.id);
          }
        }
        return {};
      }
    }
    m = path.match(
      new RegExp(`^/v2\\.0/flows/${FLOW}/intents/([0-9a-f]{24})$`),
    );
    if (m) {
      const rec = find(m[1]);
      if (method === "get") {
        return {
          _id: rec.id,
          name: rec.name,
          childFeatures: rec.childFeatures,
        };
      }
      if (method === "patch") {
        if ("name" in body) rec.name = body.name;
        if ("childFeatures" in body) rec.childFeatures = body.childFeatures;
        if ("biasTowardsParentOrChildIntents" in body) {
          rec.priority = body.biasTowardsParentOrChildIntents;
        }
        if ("parentIntentId" in body) rec.parent = body.parentIntentId;
        return {};
      }
      if (method === "delete") {
        intents.splice(intents.indexOf(rec), 1);
        return {};
      }
    }
    throw new Error(`fake: unrouted ${method} ${path}`);
  };

  const hook: { fn?: (c: Call) => void } = {};
  const overrides: Array<{ method: Method; path: RegExp; value: unknown }> = [];
  const run = async (c: Call) => {
    calls.push(c);
    hook.fn?.(c);
    const f = failures.find(
      (x) =>
        x.method === c.method &&
        x.path.test(c.path) &&
        (x.when ? x.when(c) : true) &&
        (x.times === undefined || x.times > 0),
    );
    if (f) {
      if (f.times !== undefined) f.times -= 1;
      const resp = {
        response: { status: f.status, data: { message: SECRET } },
      };
      throw Object.assign(
        new Error(SECRET),
        f.status === undefined
          ? {}
          : f.shape === "plain"
            ? { status: f.status }
            : f.shape === "both"
              ? { ...resp, status: 404 }
              : resp,
      );
    }
    const o = overrides.find(
      (x) => x.method === c.method && x.path.test(c.path),
    );
    if (o) return JSON.parse(JSON.stringify(o.value));
    return JSON.parse(JSON.stringify(route(c) ?? {}));
  };

  const api = {
    get: jest.fn(async (path: string, config?: any) =>
      run({ method: "get", path, params: config?.params }),
    ),
    post: jest.fn(async (path: string, data?: any, config?: any) =>
      run({ method: "post", path, body: data, params: config?.params }),
    ),
    patch: jest.fn(async (path: string, data?: any, config?: any) =>
      run({ method: "patch", path, body: data, params: config?.params }),
    ),
    delete: jest.fn(async (path: string, config?: any) =>
      run({ method: "delete", path, params: config?.params }),
    ),
  };

  return {
    api: api as any,
    calls,
    writes: () => calls.filter((c) => c.method !== "get"),
    gets: (path: string) =>
      calls.filter((c) => c.method === "get" && c.path === path),
    sentenceCalls: () => calls.filter((c) => c.path.includes("/sentences")),
    fail: (f: Failure) => failures.push(f),
    onCall: (fn: (c: Call) => void) => {
      hook.fn = fn;
    },
    respond: (method: Method, path: RegExp, value: unknown) =>
      overrides.push({ method, path, value }),
    setTaskStatuses: (s: string[]) => {
      taskStatuses = [...s];
    },
    sentenceTexts: (id: string) => find(id).sentences.map((s) => s.text),
    sentenceIds: (id: string) => find(id).sentences.map((s) => s._id),
    record: (id: string) => find(id),
    has: (id: string) => intents.some((i) => i.id === id),
  };
}
type Platform = ReturnType<typeof makePlatform>;

const clock = () => {
  let t = 0;
  const sleep = jest.fn(async (ms: number) => {
    t += ms;
  });
  return { now: () => t, sleep };
};

const call = (p: Platform, args: Record<string, unknown>, deps?: any) =>
  handleManageIntents(p.api, { flowId: FLOW, ...args }, deps) as Promise<any>;

const noWrites = (p: Platform) => expect(p.writes()).toEqual([]);
const noSecret = (r: unknown) =>
  expect(JSON.stringify(r)).not.toContain(SECRET);
const noSentence = (r: unknown) =>
  expect(JSON.stringify(r)).not.toContain(SENTINEL);

const orphanSeed = (): SeedIntent[] => [
  ...defaultSeed(),
  { id: LOST, name: "Lost", parent: MISSING_PARENT, sentences: [] },
];
const failNextPage = (p: Platform) =>
  p.fail({
    method: "get",
    path: new RegExp(`${LIST_PATH}$`),
    status: 500,
    when: (c) => c.params?.next !== undefined,
  });

const csv = (rows: Array<[string, string]>) =>
  rows.map(([i, s]) => `${i},exampleSentence,${s}`).join("\n") + "\n";
const reader = (text: string) =>
  jest.fn<(p: string) => Promise<string>>().mockResolvedValue(text);

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
describe("manage_intents list", () => {
  const FULL = [
    {
      id: FAM,
      name: "Family",
      parentId: null,
      childIds: [GRP],
      depth: 1,
      priority: "children",
      childFeatures: true,
      sentenceCount: 6,
      effectiveSentenceCount: 14,
    },
    {
      id: GRP,
      name: "Group",
      parentId: FAM,
      childIds: [TAG],
      depth: 2,
      childFeatures: true,
      sentenceCount: 3,
      effectiveSentenceCount: 8,
    },
    {
      id: TAG,
      name: "Tag",
      parentId: GRP,
      childIds: [],
      depth: 3,
      sentenceCount: 5,
    },
    {
      id: OTH,
      name: "Other",
      parentId: null,
      childIds: [],
      depth: 1,
      sentenceCount: 0,
    },
  ];

  it("returns the whole hierarchy with counts by default and no extra keys", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "list" });
    expect(r).toEqual({
      operation: "list",
      flowId: FLOW,
      total: 4,
      maxDepth: 3,
      intents: FULL,
    });
    expect(r._hints).toBeUndefined();
    noWrites(p);
    noSentence(r);
  });

  it("reads the list with limit 100 and includeChildren, without includeFeedbackReport", async () => {
    const p = makePlatform();
    await call(p, { operation: "list" });
    expect(p.gets(LIST_PATH).map((c) => c.params)).toEqual([
      { limit: 100, includeChildren: true },
    ]);
  });

  it("with includeSentenceCounts false it omits counts and makes no sentence request", async () => {
    const p = makePlatform();
    const r = await call(p, {
      operation: "list",
      includeSentenceCounts: false,
    });
    expect(r.intents).toEqual(
      FULL.map(
        ({ sentenceCount, effectiveSentenceCount, ...rest }: any) => rest,
      ),
    );
    expect(r.countsIncomplete).toBeUndefined();
    expect(p.sentenceCalls()).toEqual([]);
  });

  it("with includeStatus true it requests the feedback report and adds a status per intent", async () => {
    const p = makePlatform({
      intents: defaultSeed().map((s) =>
        s.id === TAG
          ? {
              ...s,
              feedbackReport: {
                findings: [
                  {
                    type: "lowDataIntents",
                    intents: [{ intentName: "Tag", intentId: TAG }],
                  },
                ],
              },
            }
          : s.id === FAM
            ? { ...s, feedbackReport: { findings: [] } }
            : s,
      ),
    });
    const r = await call(p, { operation: "list", includeStatus: true });
    expect(p.gets(LIST_PATH)[0].params).toEqual({
      limit: 100,
      includeChildren: true,
      includeFeedbackReport: true,
    });
    const byName = Object.fromEntries(r.intents.map((i: any) => [i.name, i]));
    expect(byName.Tag.status).toEqual({
      state: "low_data",
      reasons: [{ type: "lowDataIntents", intents: ["Tag"] }],
    });
    // present feedbackReport with empty findings: evaluated, nothing found
    expect(byName.Family.status).toEqual({ state: "ok", reasons: [] });
    // no feedbackReport property at all: the platform did not evaluate it (4H)
    expect(byName.Other.status).toEqual({ state: "unknown", reasons: [] });
  });

  it("without includeStatus no status field is present", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "list", includeStatus: false });
    for (const i of r.intents) expect(i.status).toBeUndefined();
    expect(p.gets(LIST_PATH)[0].params.includeFeedbackReport).toBeUndefined();
  });

  it("reports truncated with a warning when a later page fails", async () => {
    const p = makePlatform({ pageSize: 2 });
    failNextPage(p);
    const r = await call(p, { operation: "list" });
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(4);
    expect(r.intents.map((i: any) => i.name)).toEqual(["Family", "Group"]);
    expect(typeof r._hints.warning).toBe("string");
    expect(r._hints.warning.length).toBeGreaterThan(0);
    noSecret(r);
  });

  it("reports countsIncomplete with a warning and leaves the failed count out", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const r = await call(p, { operation: "list" });
    expect(r.countsIncomplete).toBe(true);
    const tag = r.intents.find((i: any) => i.name === "Tag");
    expect("sentenceCount" in tag).toBe(false);
    expect(r.intents.find((i: any) => i.name === "Family").sentenceCount).toBe(
      6,
    );
    expect(r._hints.warning.length).toBeGreaterThan(0);
    expect(r.truncated).toBeUndefined();
    expect(r.problems).toBeUndefined();
    noSecret(r);
  });

  describe("effectiveSentenceCount", () => {
    const B = hid("a", 1);
    const P = hid("a", 2);
    const C = hid("a", 3);
    const K = hid("a", 4);
    const n = (x: number) =>
      Array.from({ length: x }, (_, i) => `${SENTINEL} s${i}`);
    const seed = (payInherits: boolean): SeedIntent[] => [
      {
        id: B,
        name: "Billing",
        parent: null,
        childFeatures: true,
        sentences: [],
      },
      {
        id: P,
        name: "Payments",
        parent: B,
        childFeatures: payInherits,
        sentences: [],
      },
      { id: C, name: "Card", parent: P, sentences: n(6) },
      { id: K, name: "Bank", parent: P, sentences: n(6) },
    ];
    const byName = (r: any) =>
      Object.fromEntries(r.intents.map((i: any) => [i.name, i]));

    it("sums children recursively into inheriting parents only", async () => {
      const p = makePlatform({ intents: seed(true) });
      const r = byName(await call(p, { operation: "list" }));
      expect(r.Billing.effectiveSentenceCount).toBe(12);
      expect(r.Billing.sentenceCount).toBe(0);
      expect(r.Payments.effectiveSentenceCount).toBe(12);
      expect("effectiveSentenceCount" in r.Card).toBe(false);
      expect("effectiveSentenceCount" in r.Bank).toBe(false);
    });

    it("a parent that does not inherit has no field and passes only its own count up", async () => {
      const p = makePlatform({ intents: seed(false) });
      const r = byName(await call(p, { operation: "list" }));
      expect("effectiveSentenceCount" in r.Payments).toBe(false);
      expect(r.Billing.effectiveSentenceCount).toBe(0);
    });

    it("is left out when a needed count is missing", async () => {
      const p = makePlatform({ intents: seed(true) });
      p.fail({
        method: "get",
        path: new RegExp(`/${C}/sentences$`),
        status: 500,
      });
      const res = await call(p, { operation: "list" });
      const r = byName(res);
      expect(res.countsIncomplete).toBe(true);
      expect("effectiveSentenceCount" in r.Payments).toBe(false);
      expect("effectiveSentenceCount" in r.Billing).toBe(false);
    });

    it("is absent everywhere without sentence counts", async () => {
      const p = makePlatform({ intents: seed(true) });
      const res = await call(p, {
        operation: "list",
        includeSentenceCounts: false,
      });
      for (const i of res.intents) {
        expect("effectiveSentenceCount" in i).toBe(false);
      }
    });
  });

  it("reports countsIncomplete when a childFeatures lookup fails", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${FAM}$`),
      status: 500,
    });
    const r = await call(p, { operation: "list" });
    expect(r.countsIncomplete).toBe(true);
    expect("childFeatures" in r.intents[0]).toBe(false);
    expect(r._hints.warning.length).toBeGreaterThan(0);
    noSecret(r);
  });

  it("reports problems (orphan) with a warning", async () => {
    const p = makePlatform({ intents: orphanSeed() });
    const r = await call(p, { operation: "list" });
    expect(r.problems).toEqual([{ id: LOST, problem: "orphan" }]);
    expect(r._hints.warning.length).toBeGreaterThan(0);
    expect(r.truncated).toBeUndefined();
    expect(r.countsIncomplete).toBeUndefined();
  });

  it("returns flow_not_readable with the http status and no upstream text", async () => {
    const p = makePlatform();
    p.fail({ method: "get", path: new RegExp(`${LIST_PATH}$`), status: 503 });
    const r = await call(p, { operation: "list" });
    expect(r).toMatchObject({
      operation: "list",
      error: "flow_not_readable",
      httpStatus: 503,
    });
    noSecret(r);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------
describe("manage_intents get", () => {
  const GROUP_SUMMARY = {
    id: GRP,
    name: "Group",
    parentId: FAM,
    childIds: [TAG],
    depth: 2,
    childFeatures: true,
    sentenceCount: 3,
  };

  it("finds an intent by name and returns no sentences by default", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "get", intent: "Group" });
    expect(r).toEqual({
      operation: "get",
      flowId: FLOW,
      intent: GROUP_SUMMARY,
    });
    expect("sentences" in r).toBe(false);
    noSentence(r);
    noWrites(p);
  });

  it("counts only the requested intent after a tree read without counts", async () => {
    const p = makePlatform();
    await call(p, { operation: "get", intent: "Group" });
    expect(p.sentenceCalls().map((c) => [c.path, c.params])).toEqual([
      [sentPath(GRP), { limit: 1 }],
    ]);
    expect(p.gets(intentPath(GRP))).toHaveLength(1);
  });

  it("resolves by id and by path", async () => {
    const p = makePlatform();
    const byId = await call(p, { operation: "get", intent: GRP });
    const byPath = await call(p, { operation: "get", intent: "Family/Group" });
    expect(byId.intent).toEqual(GROUP_SUMMARY);
    expect(byPath.intent).toEqual(GROUP_SUMMARY);
  });

  it("returns trimmed sentences in platform order with includeSentences", async () => {
    const p = makePlatform();
    const r = await call(p, {
      operation: "get",
      intent: "Group",
      includeSentences: true,
    });
    expect(r.sentences).toEqual([
      `${SENTINEL} grp 1`,
      `${SENTINEL} grp 2`,
      `${SENTINEL} grp 3`,
    ]);
    expect(r.intent).toEqual(GROUP_SUMMARY);
    const sentGets = p.gets(sentPath(GRP)).map((c) => c.params);
    expect(sentGets).toContainEqual({ limit: 100 });
  });

  it("returns not_found without requesting the intent", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "get", intent: "Nope" });
    expect(r).toEqual({ operation: "get", error: "not_found" });
    expect(p.gets(intentPath(GRP))).toEqual([]);
    expect(p.sentenceCalls()).toEqual([]);
  });

  it("returns tree_incomplete, not not_found, when the read is truncated and the intent is missing", async () => {
    const p = makePlatform({ pageSize: 2 });
    failNextPage(p);
    const r = await call(p, { operation: "get", intent: "Tag" });
    expect(r).toEqual({ operation: "get", error: "tree_incomplete" });
    expect(p.gets(intentPath(TAG))).toEqual([]);
    noWrites(p);
  });

  it("still resolves an intent that was read before the truncation", async () => {
    const p = makePlatform({ pageSize: 2 });
    failNextPage(p);
    const r = await call(p, { operation: "get", intent: "Family" });
    expect(r.error).toBeUndefined();
    expect(r.intent.id).toBe(FAM);
  });

  it("returns ambiguous with candidates in input order", async () => {
    const p = makePlatform({ intents: [...defaultSeed(), ...dupSeeds()] });
    const r = await call(p, { operation: "get", intent: "Dup" });
    expect(r).toEqual({
      operation: "get",
      error: "ambiguous",
      candidates: [DUP1, DUP2],
    });
  });

  it("returns request_failed with the status and no upstream text", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${GRP}/sentences$`),
      status: 500,
    });
    const r = await call(p, { operation: "get", intent: "Group" });
    expect(r.error).toBe("request_failed");
    expect(r.httpStatus).toBe(500);
    noSecret(r);
  });
});

// ---------------------------------------------------------------------------
// export_tree
// ---------------------------------------------------------------------------
describe("manage_intents export_tree", () => {
  it("returns the compact tree including sentence counts", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "export_tree" });
    expect(r).toEqual({
      operation: "export_tree",
      flowId: FLOW,
      total: 4,
      maxDepth: 3,
      intents: [
        {
          id: FAM,
          name: "Family",
          parentId: null,
          depth: 1,
          childFeatures: true,
          priority: "children",
          sentenceCount: 6,
          effectiveSentenceCount: 14,
        },
        {
          id: GRP,
          name: "Group",
          parentId: FAM,
          depth: 2,
          childFeatures: true,
          sentenceCount: 3,
          effectiveSentenceCount: 8,
        },
        { id: TAG, name: "Tag", parentId: GRP, depth: 3, sentenceCount: 5 },
        { id: OTH, name: "Other", parentId: null, depth: 1, sentenceCount: 0 },
      ],
    });
    expect(p.sentenceCalls()).toHaveLength(4);
    noWrites(p);
    noSentence(r);
  });

  it("carries truncated when the read was truncated", async () => {
    const p = makePlatform({ pageSize: 2 });
    failNextPage(p);
    const r = await call(p, { operation: "export_tree" });
    expect(r.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// below_minimum
// ---------------------------------------------------------------------------
describe("manage_intents below_minimum", () => {
  const view = (r: any) =>
    r.intents.map((i: any) => [i.name, i.sentenceCount, i.missing]);

  it("uses 5 as the default minimum and does not list an intent exactly at it", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "below_minimum" });
    expect(r.operation).toBe("below_minimum");
    expect(r.flowId).toBe(FLOW);
    expect(r.threshold).toBe(5);
    // Round 6: Group (own 3) inherits Tag's 5 and is checked at 8, so only
    // the childless Other is listed.
    expect(r).toEqual({
      operation: "below_minimum",
      flowId: FLOW,
      threshold: 5,
      count: 1,
      intents: [{ name: "Other", id: OTH, sentenceCount: 0, missing: 5 }],
    });
    expect(r._hints).toBeUndefined();
    noWrites(p);
    noSentence(r);
  });

  it("reads childFeatures of the parents but not of the leaves", async () => {
    const p = makePlatform();
    await call(p, { operation: "below_minimum" });
    expect(p.gets(intentPath(FAM))).toHaveLength(1);
    expect(p.gets(intentPath(GRP))).toHaveLength(1);
    expect(p.gets(intentPath(TAG))).toEqual([]);
    expect(p.gets(intentPath(OTH))).toEqual([]);
  });

  // Tree: Billing(own 0) > Payments(own 0) > Card(6), Bank(6); all parents inherit.
  const BILL = hid("a", 1);
  const PAY = hid("a", 2);
  const CARD = hid("a", 3);
  const BANK = hid("a", 4);
  const texts = (n: number) =>
    Array.from({ length: n }, (_, i) => `${SENTINEL} s${i}`);
  const billingSeed = (payInherits = true): SeedIntent[] => [
    {
      id: BILL,
      name: "Billing",
      parent: null,
      childFeatures: true,
      sentences: [],
    },
    {
      id: PAY,
      name: "Payments",
      parent: BILL,
      childFeatures: payInherits,
      sentences: [],
    },
    { id: CARD, name: "Card", parent: PAY, sentences: texts(6) },
    { id: BANK, name: "Bank", parent: PAY, sentences: texts(6) },
  ];

  it("does not list an inheriting parent with no own sentences when its children have enough", async () => {
    const p = makePlatform({ intents: billingSeed() });
    const r = await call(p, { operation: "below_minimum" });
    expect(r).toEqual({
      operation: "below_minimum",
      flowId: FLOW,
      threshold: 5,
      count: 0,
      intents: [],
    });
  });

  it("lists an inheriting parent below the minimum with the effective count and its own count", async () => {
    const PARENT = hid("a", 1);
    const CHILD = hid("a", 2);
    const p = makePlatform({
      intents: [
        {
          id: PARENT,
          name: "P",
          parent: null,
          childFeatures: true,
          sentences: texts(1),
        },
        { id: CHILD, name: "C", parent: PARENT, sentences: texts(2) },
      ],
    });
    const r = await call(p, { operation: "below_minimum" });
    expect(r.count).toBe(2);
    expect(r.intents).toEqual([
      { name: "C", id: CHILD, sentenceCount: 2, missing: 3 },
      {
        name: "P",
        id: PARENT,
        sentenceCount: 3,
        missing: 2,
        ownSentenceCount: 1,
      },
    ]);
    expect("ownSentenceCount" in r.intents[0]).toBe(false);
  });

  it("lists a non-inheriting parent with its own count and no ownSentenceCount", async () => {
    const PARENT = hid("a", 1);
    const CHILD = hid("a", 2);
    const p = makePlatform({
      intents: [
        {
          id: PARENT,
          name: "N",
          parent: null,
          childFeatures: false,
          sentences: [],
        },
        { id: CHILD, name: "K", parent: PARENT, sentences: texts(6) },
      ],
    });
    const r = await call(p, { operation: "below_minimum" });
    expect(r.intents).toEqual([
      { name: "N", id: PARENT, sentenceCount: 0, missing: 5 },
    ]);
    expect("ownSentenceCount" in r.intents[0]).toBe(false);
  });

  it("separates 4 from 5 on effective counts", async () => {
    const A = hid("a", 1);
    const AC = hid("a", 2);
    const B = hid("a", 3);
    const BC = hid("a", 4);
    const p = makePlatform({
      intents: [
        {
          id: A,
          name: "FourEff",
          parent: null,
          childFeatures: true,
          sentences: texts(2),
        },
        { id: AC, name: "AChild", parent: A, sentences: texts(2) },
        {
          id: B,
          name: "FiveEff",
          parent: null,
          childFeatures: true,
          sentences: texts(2),
        },
        { id: BC, name: "BChild", parent: B, sentences: texts(3) },
      ],
    });
    const r = await call(p, { operation: "below_minimum", min: 5 });
    // Leaves are checked on their own counts, inheriting parents on effective.
    expect(r.intents).toEqual([
      { name: "AChild", id: AC, sentenceCount: 2, missing: 3 },
      { name: "BChild", id: BC, sentenceCount: 3, missing: 2 },
      {
        name: "FourEff",
        id: A,
        sentenceCount: 4,
        missing: 1,
        ownSentenceCount: 2,
      },
    ]);
    expect(r.count).toBe(3);
  });

  it("a child that does not inherit contributes only its own count to its parent", async () => {
    const p = makePlatform({ intents: billingSeed(false) });
    const r = await call(p, { operation: "below_minimum" });
    // Payments does not inherit (own 0, listed at 0); Billing = 0 + Payments' own 0 = 0
    expect(r.intents).toEqual([
      {
        name: "Billing",
        id: BILL,
        sentenceCount: 0,
        missing: 5,
        ownSentenceCount: 0,
      },
      { name: "Payments", id: PAY, sentenceCount: 0, missing: 5 },
    ]);
  });

  it("applies a custom minimum to the effective counts", async () => {
    const p = makePlatform({ intents: billingSeed() });
    const r = await call(p, { operation: "below_minimum", min: 13 });
    expect(r.threshold).toBe(13);
    expect(r.count).toBe(4);
    expect(r.intents).toEqual([
      { name: "Bank", id: BANK, sentenceCount: 6, missing: 7 },
      { name: "Card", id: CARD, sentenceCount: 6, missing: 7 },
      {
        name: "Billing",
        id: BILL,
        sentenceCount: 12,
        missing: 1,
        ownSentenceCount: 0,
      },
      {
        name: "Payments",
        id: PAY,
        sentenceCount: 12,
        missing: 1,
        ownSentenceCount: 0,
      },
    ]);
    const at12 = await call(p, { operation: "below_minimum", min: 12 });
    expect(at12.count).toBe(2);
    expect(at12.intents).toEqual([
      { name: "Bank", id: BANK, sentenceCount: 6, missing: 6 },
      { name: "Card", id: CARD, sentenceCount: 6, missing: 6 },
    ]);
    const at6 = await call(p, { operation: "below_minimum", min: 6 });
    expect(at6.count).toBe(0);
    expect(at6.intents).toEqual([]);
  });

  it("separates 4 from 5 at the boundary", async () => {
    const p = makePlatform({
      intents: [
        {
          id: FAM,
          name: "Four",
          parent: null,
          sentences: ["a", "b", "c", "d"].map((x) => `${SENTINEL} ${x}`),
        },
        {
          id: GRP,
          name: "Five",
          parent: null,
          sentences: ["a", "b", "c", "d", "e"].map((x) => `${SENTINEL} ${x}`),
        },
      ],
    });
    const r = await call(p, { operation: "below_minimum" });
    expect(view(r)).toEqual([["Four", 4, 1]]);
    expect(r.count).toBe(1);
  });

  it("honours a custom minimum", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "below_minimum", min: 9 });
    expect(r.threshold).toBe(9);
    expect(r.count).toBe(3);
    expect(r.intents).toEqual([
      { name: "Other", id: OTH, sentenceCount: 0, missing: 9 },
      { name: "Tag", id: TAG, sentenceCount: 5, missing: 4 },
      {
        name: "Group",
        id: GRP,
        sentenceCount: 8,
        missing: 1,
        ownSentenceCount: 3,
      },
    ]);
  });

  it("leaves intents without a count out and warns", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${GRP}/sentences$`),
      status: 500,
    });
    const r = await call(p, { operation: "below_minimum" });
    expect(view(r)).toEqual([["Other", 0, 5]]);
    expect(r.count).toBe(1);
    expect(r.countsIncomplete).toBe(true);
    expect(r.uncountedIntents).toEqual(["Group"]);
    expect(r._hints.warning.length).toBeGreaterThan(0);
    noSecret(r);
  });

  it("has no uncountedIntents key when every intent has a count", async () => {
    const p = makePlatform();
    const r = await call(p, { operation: "below_minimum" });
    expect("uncountedIntents" in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------
describe("manage_intents compare", () => {
  it("compares the csv read through deps.readFile with the flow", async () => {
    const p = makePlatform();
    const readFile = reader(
      csv([
        ["Family", "csvone"],
        ["Family", "csvdup"],
        ["Family", "csvdup"],
        ["Family", "csvfour"],
        ["Family", "csvfive"],
        ["Family", "csvsix"],
        ["Group", "csvg1"],
        ["Group", "csvg2"],
        ["Ghost", "csvx"],
      ]),
    );
    const r = await call(
      p,
      { operation: "compare", file: "data/intents.csv" },
      { readFile },
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0][0]).toBe("data/intents.csv");
    expect(r).toEqual({
      operation: "compare",
      flowId: FLOW,
      file: "data/intents.csv",
      rows: 9,
      parseErrors: { count: 0, first: [] },
      report: {
        missing: ["Ghost"],
        extra: ["Other", "Tag"],
        duplicateIntentNames: [],
        duplicateSentences: [
          { intent: "Family", sentence: "csvdup", count: 2 },
        ],
        wrongCount: [{ intent: "Group", csvCount: 2, flowCount: 3 }],
        summary: { flowIntents: 4, csvIntents: 3, csvRows: 9, matching: 1 },
      },
    });
    noWrites(p);
    noSentence(r);
  });

  it("reports parse errors with the total count and at most 20 listed", async () => {
    const p = makePlatform();
    const bad = Array.from({ length: 25 }, (_, i) => `onlyone${i}`).join("\n");
    const readFile = reader(`${bad}\nFamily,exampleSentence,csvok\n`);
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile },
    );
    expect(r.rows).toBe(1);
    expect(r.parseErrors.count).toBe(25);
    expect(r.parseErrors.first).toEqual(
      Array.from({ length: 20 }, (_, i) => ({
        line: i + 1,
        error: "wrong_column_count",
      })),
    );
  });

  it("maps a FileAccessError to file_error and reads nothing from the platform", async () => {
    const p = makePlatform();
    const readFile = jest
      .fn<(p: string) => Promise<string>>()
      .mockRejectedValue(
        new FileAccessError("fixed refusal text", "outside_root"),
      );
    const r = await call(
      p,
      { operation: "compare", file: "../secret.csv" },
      { readFile },
    );
    expect(r).toEqual({
      operation: "compare",
      error: "file_error",
      code: "outside_root",
      message: "fixed refusal text",
    });
    expect(p.calls).toEqual([]);
  });

  it("flags incomplete counts, compares only intents with a count, and warns", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const readFile = reader(
      csv(
        [1, 2, 3, 4, 5, 6].map(
          (n) => ["Family", `csv${n}`] as [string, string],
        ),
      ),
    );
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile },
    );
    expect(r.countsIncomplete).toBe(true);
    expect(r._hints.warning.length).toBeGreaterThan(0);
    expect(r.report.summary.flowIntents).toBe(3);
    expect(r.report.extra).toEqual(["Group", "Other"]);
    expect(r.uncountedIntents).toEqual(["Tag"]);
    noSecret(r);
  });

  it("does not report an uncounted intent as missing and lists it as uncounted", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const rows: Array<[string, string]> = [
      ...[1, 2, 3, 4, 5, 6].map(
        (n) => ["Family", `csv${n}`] as [string, string],
      ),
      ["Tag", "csvtag"],
      ["Ghost", "csvghost"],
    ];
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile: reader(csv(rows)) },
    );
    expect(r).toEqual({
      operation: "compare",
      flowId: FLOW,
      file: "x.csv",
      rows: 8,
      parseErrors: { count: 0, first: [] },
      countsIncomplete: true,
      uncountedIntents: ["Tag"],
      report: {
        missing: ["Ghost"],
        extra: ["Group", "Other"],
        duplicateIntentNames: [],
        duplicateSentences: [],
        wrongCount: [],
        summary: { flowIntents: 3, csvIntents: 3, csvRows: 8, matching: 1 },
      },
      _hints: { warning: expect.any(String) },
    });
    expect(r._hints.warning.length).toBeGreaterThan(0);
  });

  it("lists several uncounted intents in tree order", async () => {
    const p = makePlatform();
    for (const id of [TAG, FAM]) {
      p.fail({
        method: "get",
        path: new RegExp(`/${id}/sentences$`),
        status: 500,
      });
    }
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile: reader(csv([["Tag", "csvtag"]])) },
    );
    expect(r.uncountedIntents).toEqual(["Family", "Tag"]);
    expect(r.report.missing).toEqual([]);
  });

  it("has no uncountedIntents key when every intent has a count", async () => {
    const p = makePlatform();
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile: reader(csv([["Family", "csvone"]])) },
    );
    expect("uncountedIntents" in r).toBe(false);
    expect(r.countsIncomplete).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// model_state
// ---------------------------------------------------------------------------
describe("manage_intents model_state", () => {
  it("reports an out-of-date model from two GETs and nothing else", async () => {
    const p = makePlatform({ outOfDate: true });
    const r = await call(p, { operation: "model_state" });
    expect(r).toEqual({
      operation: "model_state",
      flowId: FLOW,
      upToDate: false,
      intentTotal: 4,
      lastTrainedAt: null,
      note: expect.stringContaining("no last-trained time"),
    });
    expect(r.note).toContain("null was observed");
    expect(p.calls.map((c) => [c.method, c.path, c.params])).toEqual([
      ["get", FLOW_PATH, undefined],
      ["get", LIST_PATH, { limit: 1, includeChildren: true }],
    ]);
  });

  it("the fake counts only roots without includeChildren, so a wrong call gives a smaller total", async () => {
    const p = makePlatform();
    const wrong = await p.api.get(LIST_PATH, { params: { limit: 1 } });
    const right = await p.api.get(LIST_PATH, {
      params: { limit: 1, includeChildren: true },
    });
    expect(wrong.total).toBe(2);
    expect(right.total).toBe(4);
  });

  it("reports an up-to-date model", async () => {
    const p = makePlatform({ outOfDate: false });
    const r = await call(p, { operation: "model_state" });
    expect(r.upToDate).toBe(true);
  });

  it("reports unknown when the flow does not say", async () => {
    const p = makePlatform({ outOfDate: null });
    const r = await call(p, { operation: "model_state" });
    expect(r.upToDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
describe("manage_intents create", () => {
  const base = { operation: "create", projectId: PROJECT };

  it("creates a root intent with only the provided fields in the body", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, name: "Fresh" });
    expect(p.writes()).toEqual([
      { method: "post", path: LIST_PATH, body: { name: "Fresh" } },
    ]);
    expect(r).toEqual({
      operation: "create",
      flowId: FLOW,
      intent: { id: NEW1, name: "Fresh", parentId: null, depth: 1 },
    });
    expect("sentences" in r).toBe(false);
  });

  it("sends optional fields under a parent given by name", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      name: "Child",
      parent: "Other",
      childFeatures: true,
      priority: "parents",
    });
    expect(p.writes()).toEqual([
      {
        method: "post",
        path: LIST_PATH,
        body: {
          name: "Child",
          parentIntentId: OTH,
          childFeatures: true,
          biasTowardsParentOrChildIntents: "parents",
        },
      },
    ]);
    expect(r.intent).toEqual({
      id: NEW1,
      name: "Child",
      parentId: OTH,
      depth: 2,
    });
  });

  it("sends childFeatures false when it was provided", async () => {
    const p = makePlatform();
    await call(p, { ...base, name: "Child", childFeatures: false });
    expect(p.writes()[0].body).toEqual({
      name: "Child",
      childFeatures: false,
    });
  });

  it("resolves the parent by id", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, name: "Child", parent: FAM });
    expect(p.writes()[0].body.parentIntentId).toBe(FAM);
    expect(r.intent.depth).toBe(2);
  });

  it("resolves the parent by an A/B path and reaches level 3", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, name: "Leaf", parent: "Family/Group" });
    expect(p.writes()[0].body.parentIntentId).toBe(GRP);
    expect(r.intent).toEqual({
      id: NEW1,
      name: "Leaf",
      parentId: GRP,
      depth: 3,
    });
  });

  it("refuses a fourth level and creates nothing", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      name: "TooDeep",
      parent: "Family/Group/Tag",
    });
    expect(r).toEqual({
      operation: "create",
      error: "max_depth_exceeded",
      message: expect.stringContaining("3 levels"),
    });
    noWrites(p);
  });

  it("refuses an unknown parent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, name: "X", parent: "Nope" });
    expect(r).toEqual({ operation: "create", error: "parent_not_found" });
    noWrites(p);
  });

  it("refuses an ambiguous parent with candidates", async () => {
    const p = makePlatform({ intents: [...defaultSeed(), ...dupSeeds()] });
    const r = await call(p, { ...base, name: "X", parent: "Dup" });
    expect(r).toEqual({
      operation: "create",
      error: "ambiguous",
      candidates: [DUP1, DUP2],
    });
    noWrites(p);
  });

  it.each([
    ["an empty object", {}],
    ["an empty id", { _id: "" }],
    ["a numeric id", { _id: 123 }],
    ["null", null],
  ])(
    "returns request_failed and imports nothing when the POST resolves with %s",
    async (_n, response) => {
      const p = makePlatform();
      p.respond("post", new RegExp(`${LIST_PATH}$`), response);
      const r = await call(p, {
        ...base,
        name: "Fresh",
        sentences: [`${SENTINEL} new 1`],
      });
      expect(r).toEqual({
        operation: "create",
        error: "request_failed",
        _hints: { action: expect.any(String) },
      });
      expect(r._hints.action.length).toBeGreaterThan(0);
      expect(r._hints.action).toContain("may have been created");
      expect("intent" in r).toBe(false);
      expect(p.writes().map((c) => [c.method, c.path])).toEqual([
        ["post", LIST_PATH],
      ]);
      expect(p.sentenceCalls()).toEqual([]);
    },
  );

  // Changed in round 4: a flow GET that resolves with a non-object has no
  // projectReference, so the project check (4C) now refuses it instead of
  // creating without localeReference.
  it.each([
    ["null", null],
    ["a string", "not an object"],
  ])(
    "refuses with project_mismatch when the flow GET resolves with %s",
    async (_n, flowResponse) => {
      const p = makePlatform();
      p.respond("get", new RegExp(`${FLOW_PATH}$`), flowResponse);
      const r = await call(p, { ...base, name: "Fresh" });
      expect(r).toEqual({ operation: "create", error: "project_mismatch" });
      noWrites(p);
    },
  );

  // Round 5 (replaces the round-4 tests that asserted localeReference was
  // omitted only when the flow had none): create never sends it.
  it.each([
    ["a string locale", { localeReference: LOC }],
    ["no locale", {}],
    ["a numeric locale", { localeReference: 42 }],
    ["an empty locale", { localeReference: "" }],
  ])(
    "never sends localeReference whatever the verified flow carries (%s)",
    async (_n, extra) => {
      const p = makePlatform();
      p.respond("get", new RegExp(`${FLOW_PATH}$`), {
        _id: FLOW,
        projectReference: PROJECT,
        ...extra,
      });
      const r = await call(p, { ...base, name: "Fresh" });
      expect(p.writes()).toEqual([
        { method: "post", path: LIST_PATH, body: { name: "Fresh" } },
      ]);
      expect(r).toEqual({
        operation: "create",
        flowId: FLOW,
        intent: { id: NEW1, name: "Fresh", parentId: null, depth: 1 },
      });
    },
  );

  it("the platform rejects a localeReference in the create body (fake guard)", async () => {
    const p = makePlatform();
    await expect(
      p.api.post(LIST_PATH, { name: "X", localeReference: LOC }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("imports sentences afterwards through the sentences PATCH", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      name: "Fresh",
      sentences: [`${SENTINEL} new 1`, `${SENTINEL} new 2`],
    });
    expect(p.writes()).toEqual([
      {
        method: "post",
        path: LIST_PATH,
        body: { name: "Fresh" },
      },
      {
        method: "patch",
        path: sentPath(NEW1),
        body: {
          operations: [
            { op: "create", value: { text: `${SENTINEL} new 1` } },
            { op: "create", value: { text: `${SENTINEL} new 2` } },
          ],
        },
      },
    ]);
    expect(r).toEqual({
      operation: "create",
      flowId: FLOW,
      intent: { id: NEW1, name: "Fresh", parentId: null, depth: 1 },
      sentences: {
        status: "complete",
        totals: {
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
          batches: 1,
        },
      },
    });
    expect(r._hints).toBeUndefined();
    noSentence(r);
  });

  it("batches 120 sentences into PATCH calls of 50, 50 and 20", async () => {
    const p = makePlatform();
    const texts = Array.from(
      { length: 120 },
      (_, i) => `${SENTINEL} bulk ${i}`,
    );
    const r = await call(p, { ...base, name: "Fresh", sentences: texts });
    const patches = p.writes().filter((c) => c.path === sentPath(NEW1));
    expect(patches.map((c) => c.body.operations.length)).toEqual([50, 50, 20]);
    expect(r.sentences.totals.created).toBe(120);
    expect(r.sentences.totals.batches).toBe(3);
    expect(p.sentenceTexts(NEW1)).toEqual(texts);
  });

  it("still reports the created intent when the sentence import fails", async () => {
    const p = makePlatform();
    p.fail({
      method: "patch",
      path: new RegExp(`/${NEW1}/sentences$`),
      status: 500,
    });
    const r = await call(p, {
      ...base,
      name: "Fresh",
      sentences: [`${SENTINEL} new 1`],
    });
    expect(r.error).toBeUndefined();
    expect(r.intent).toEqual({
      id: NEW1,
      name: "Fresh",
      parentId: null,
      depth: 1,
    });
    expect(r.sentences).toEqual({
      status: "partial",
      totals: {
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 0,
      },
    });
    expect(r._hints.action).toContain("import_sentences");
    expect(r._hints.action).toContain("do not repeat create");
    noSecret(r);
    noSentence(r);
  });

  it("gives the same follow-up hint when the existing-sentence read fails", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${NEW1}/sentences$`),
      status: 500,
    });
    const r = await call(p, {
      ...base,
      name: "Fresh",
      sentences: [`${SENTINEL} new 1`],
    });
    expect(r.intent).toEqual({
      id: NEW1,
      name: "Fresh",
      parentId: null,
      depth: 1,
    });
    expect(r.sentences.status).toBe("partial");
    expect(r._hints.action).toContain("import_sentences");
    expect(r._hints.action).toContain("do not repeat create");
    expect(p.writes().filter((c) => c.path === sentPath(NEW1))).toEqual([]);
    noSecret(r);
    noSentence(r);
  });

  describe("duplicate sibling names", () => {
    const seed = (): SeedIntent[] => [
      ...defaultSeed(),
      { id: hid("a", 7), name: "Group", parent: OTH, sentences: [] },
    ];

    it("refuses a root name that already exists", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, name: "Other" });
      expect(r).toEqual({ operation: "create", error: "name_exists", id: OTH });
      noWrites(p);
    });

    it("compares the name after trimming", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, name: "  Other  " });
      expect(r).toEqual({ operation: "create", error: "name_exists", id: OTH });
      noWrites(p);
    });

    it("refuses a name that exists under the same parent", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, name: "Group", parent: "Family" });
      expect(r).toEqual({ operation: "create", error: "name_exists", id: GRP });
      noWrites(p);
    });

    it("allows the same name under a different parent", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, name: "Group", parent: "Other" });
      expect(r.error).toBeUndefined();
      expect(r.intent).toEqual({
        id: NEW1,
        name: "Group",
        parentId: OTH,
        depth: 2,
      });
      expect(p.writes()).toHaveLength(1);
    });

    it("allows a root name that only exists below a parent", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, name: "Tag" });
      expect(r.intent).toEqual({
        id: NEW1,
        name: "Tag",
        parentId: null,
        depth: 1,
      });
    });

    it("does not confuse a sibling elsewhere with a clash (seeded copy under Other)", async () => {
      const p = makePlatform({ intents: seed() });
      const r = await call(p, { ...base, name: "Group", parent: "Family" });
      expect(r).toEqual({ operation: "create", error: "name_exists", id: GRP });
    });
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
describe("manage_intents update", () => {
  const base = { operation: "update", projectId: PROJECT };

  it("sends only provided fields and lists changed in name, childFeatures, priority order", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      intent: "Group",
      priority: "children",
      name: "Renamed",
      childFeatures: false,
    });
    expect(p.writes()).toEqual([
      {
        method: "patch",
        path: intentPath(GRP),
        body: {
          name: "Renamed",
          childFeatures: false,
          biasTowardsParentOrChildIntents: "children",
        },
      },
    ]);
    expect(r.operation).toBe("update");
    expect(r.flowId).toBe(FLOW);
    expect(r.intent.id).toBe(GRP);
    expect(r.changed).toEqual(["name", "childFeatures", "priority"]);
  });

  it("sends a single field and reports the existing name", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Group", priority: "parents" });
    expect(p.writes()).toEqual([
      {
        method: "patch",
        path: intentPath(GRP),
        body: { biasTowardsParentOrChildIntents: "parents" },
      },
    ]);
    expect(r).toEqual({
      operation: "update",
      flowId: FLOW,
      intent: { id: GRP, name: "Group" },
      changed: ["priority"],
    });
  });

  it("refuses an unknown intent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Nope", name: "X" });
    expect(r).toEqual({ operation: "update", error: "not_found" });
    noWrites(p);
  });

  it("refuses an ambiguous intent with candidates", async () => {
    const p = makePlatform({ intents: [...defaultSeed(), ...dupSeeds()] });
    const r = await call(p, { ...base, intent: "Dup", name: "X" });
    expect(r).toEqual({
      operation: "update",
      error: "ambiguous",
      candidates: [DUP1, DUP2],
    });
    noWrites(p);
  });

  it("refuses a rename to a sibling's name", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Other", name: "Family" });
    expect(r).toEqual({ operation: "update", error: "name_exists", id: FAM });
    noWrites(p);
  });

  it("compares the new name after trimming", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Other", name: " Family " });
    expect(r).toEqual({ operation: "update", error: "name_exists", id: FAM });
    noWrites(p);
  });

  it("allows renaming to a name that exists only under another parent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Other", name: "Tag" });
    expect(r.error).toBeUndefined();
    expect(p.writes()).toEqual([
      { method: "patch", path: intentPath(OTH), body: { name: "Tag" } },
    ]);
  });

  it("does not treat the intent's own current name as a clash", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Group", name: "Group" });
    expect(r.error).toBeUndefined();
    expect(p.writes()).toEqual([
      { method: "patch", path: intentPath(GRP), body: { name: "Group" } },
    ]);
  });

  it("does not check names when no name is being changed", async () => {
    const p = makePlatform({
      intents: [
        ...defaultSeed(),
        { id: hid("a", 7), name: "Group", parent: FAM, sentences: [] },
      ],
    });
    const r = await call(p, { ...base, intent: GRP, priority: "parents" });
    expect(r.error).toBeUndefined();
    expect(p.writes()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------
describe("manage_intents move", () => {
  const base = { operation: "move", projectId: PROJECT };

  it("moves a leaf to the root with parentIntentId null", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Tag", parent: null });
    expect(p.writes()).toEqual([
      {
        method: "patch",
        path: intentPath(TAG),
        body: { parentIntentId: null },
      },
    ]);
    expect(r).toEqual({
      operation: "move",
      flowId: FLOW,
      intent: { id: TAG, name: "Tag" },
      parentId: null,
      newDepth: 1,
      deepestLevel: 1,
    });
  });

  it("moves a subtree and reports its deepest level", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Group", parent: "Other" });
    expect(p.writes()).toEqual([
      { method: "patch", path: intentPath(GRP), body: { parentIntentId: OTH } },
    ]);
    expect(r).toEqual({
      operation: "move",
      flowId: FLOW,
      intent: { id: GRP, name: "Group" },
      parentId: OTH,
      newDepth: 2,
      deepestLevel: 3,
    });
  });

  it("allows moving under the current parent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Tag", parent: "Group" });
    expect(p.writes()).toEqual([
      { method: "patch", path: intentPath(TAG), body: { parentIntentId: GRP } },
    ]);
    expect(r.newDepth).toBe(3);
  });

  it("refuses when the moved subtree would pass level 3", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Family", parent: "Other" });
    expect(r).toEqual({
      operation: "move",
      error: "max_depth_exceeded",
      message: expect.stringContaining("3 levels"),
    });
    expect(r.message).toContain("level 4");
    noWrites(p);
  });

  it("refuses a move under its own descendant", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Family", parent: "Tag" });
    expect(r).toEqual({
      operation: "move",
      error: "cycle",
      message: expect.any(String),
    });
    noWrites(p);
  });

  it("refuses a move under itself", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Group", parent: "Group" });
    expect(r.error).toBe("cycle");
    noWrites(p);
  });

  it("refuses an unknown intent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Nope", parent: null });
    expect(r).toEqual({ operation: "move", error: "not_found" });
    noWrites(p);
  });

  it("refuses an unknown parent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Tag", parent: "Nope" });
    expect(r.operation).toBe("move");
    expect(typeof r.error).toBe("string");
    expect(r.ok).not.toBe(true);
    expect(r.parentId).toBeUndefined();
    noWrites(p);
  });

  describe("duplicate sibling names", () => {
    const CLASH = hid("a", 7);
    const ROOT_TAG = hid("a", 8);
    const seed = (): SeedIntent[] => [
      ...defaultSeed(),
      { id: CLASH, name: "Group", parent: OTH, sentences: [] },
      { id: ROOT_TAG, name: "Tag", parent: null, sentences: [] },
    ];

    it("refuses a move under a parent that already has a child with that name", async () => {
      const p = makePlatform({ intents: seed() });
      const r = await call(p, {
        ...base,
        intent: "Family/Group",
        parent: "Other",
      });
      expect(r).toEqual({ operation: "move", error: "name_exists", id: CLASH });
      noWrites(p);
    });

    it("refuses a move to the root when a root has that name", async () => {
      const p = makePlatform({ intents: seed() });
      const r = await call(p, {
        ...base,
        intent: "Family/Group/Tag",
        parent: null,
      });
      expect(r).toEqual({
        operation: "move",
        error: "name_exists",
        id: ROOT_TAG,
      });
      noWrites(p);
    });

    it("allows moving under the current parent (the intent is not its own clash)", async () => {
      const p = makePlatform({ intents: seed() });
      const r = await call(p, {
        ...base,
        intent: "Family/Group",
        parent: "Family",
      });
      expect(r.error).toBeUndefined();
      expect(p.writes()).toEqual([
        {
          method: "patch",
          path: intentPath(GRP),
          body: { parentIntentId: FAM },
        },
      ]);
    });

    it("allows a move when the destination has no child with that name", async () => {
      const p = makePlatform();
      const r = await call(p, { ...base, intent: "Group", parent: "Other" });
      expect(r.error).toBeUndefined();
      expect(p.writes()).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------
describe("manage_intents delete", () => {
  const base = { operation: "delete", projectId: PROJECT };

  it("refuses an intent with children and reports the child count", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Family" });
    expect(r).toEqual({
      operation: "delete",
      error: "has_children",
      childCount: 1,
    });
    noWrites(p);
  });

  it("refuses an intent with children addressed by path", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Family/Group" });
    expect(r).toEqual({
      operation: "delete",
      error: "has_children",
      childCount: 1,
    });
    noWrites(p);
  });

  it("deletes a leaf with exactly one DELETE call", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Tag" });
    expect(p.writes()).toEqual([{ method: "delete", path: intentPath(TAG) }]);
    expect(r).toEqual({
      operation: "delete",
      flowId: FLOW,
      deleted: { id: TAG, name: "Tag" },
    });
    expect(p.has(TAG)).toBe(false);
  });

  it("refuses an unknown intent", async () => {
    const p = makePlatform();
    const r = await call(p, { ...base, intent: "Nope" });
    expect(r).toEqual({ operation: "delete", error: "not_found" });
    noWrites(p);
  });
});

// ---------------------------------------------------------------------------
// import_sentences
// ---------------------------------------------------------------------------
describe("manage_intents import_sentences", () => {
  const base = { operation: "import_sentences", projectId: PROJECT };

  // The injected clock advances when the sentence PATCHes are sent: after the
  // n-th PATCH it reads times[n-1] (the last value repeats).
  const withClock = async (
    extra: Record<string, unknown>,
    times: number[],
    entries: Array<{ intent: string; sentences: string[] }>,
  ) => {
    const p = makePlatform();
    let t = 0;
    let n = 0;
    p.onCall((c) => {
      if (c.method === "patch" && c.path.endsWith("/sentences")) {
        t = times[Math.min(n, times.length - 1)];
        n += 1;
      }
    });
    const r = await call(
      p,
      { ...base, mode: "add", entries, ...extra },
      { now: () => t },
    );
    return { p, r };
  };
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) => `${SENTINEL} bulk ${i}`);
  const patchesTo = (p: Platform, id: string) =>
    p.writes().filter((c) => c.path === sentPath(id));

  it("stops at the default 60 second deadline with the intent incomplete", async () => {
    const { p, r } = await withClock(
      {},
      [59999, 60000],
      [{ intent: "Tag", sentences: bulk(120) }],
    );
    expect(patchesTo(p, TAG)).toHaveLength(2);
    expect(r).toEqual({
      operation: "import_sentences",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      totals: {
        created: 100,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 2,
      },
      intents: [
        {
          intent: "Tag",
          id: TAG,
          created: 100,
          deleted: 0,
          skippedExisting: 0,
          status: "incomplete",
        },
      ],
      _hints: { warning: expect.any(String) },
    });
    expect(r._hints.warning.length).toBeGreaterThan(0);
    noSentence(r);
  });

  it("does not stop at 10 seconds when no deadlineSeconds is given", async () => {
    const { p, r } = await withClock(
      {},
      [9999, 10000, 10000],
      [{ intent: "Tag", sentences: bulk(120) }],
    );
    expect(patchesTo(p, TAG)).toHaveLength(3);
    expect(r.status).toBe("complete");
    expect(r.totals.created).toBe(120);
    expect(r._hints).toBeUndefined();
  });

  it("converts deadlineSeconds to milliseconds", async () => {
    const { p, r } = await withClock(
      { deadlineSeconds: 10 },
      [9999, 10000],
      [{ intent: "Tag", sentences: bulk(120) }],
    );
    expect(patchesTo(p, TAG)).toHaveLength(2);
    expect(r.status).toBe("partial");
    expect(r.intents[0]).toEqual({
      intent: "Tag",
      id: TAG,
      created: 100,
      deleted: 0,
      skippedExisting: 0,
      status: "incomplete",
    });
  });

  it("a custom deadline of 100 seconds is not stopped at 60 seconds", async () => {
    const { p, r } = await withClock(
      { deadlineSeconds: 100 },
      [60000],
      [{ intent: "Tag", sentences: bulk(120) }],
    );
    expect(patchesTo(p, TAG)).toHaveLength(3);
    expect(r.status).toBe("complete");
  });

  it("reports an intent with nothing sent as not_attempted after the deadline", async () => {
    const { p, r } = await withClock(
      {},
      [60000],
      [
        { intent: "Tag", sentences: bulk(120) },
        { intent: "Other", sentences: [`${SENTINEL} o1`] },
      ],
    );
    expect(patchesTo(p, TAG)).toHaveLength(1);
    expect(patchesTo(p, OTH)).toEqual([]);
    expect(r.status).toBe("partial");
    expect(r.intents).toEqual([
      {
        intent: "Tag",
        id: TAG,
        created: 50,
        deleted: 0,
        skippedExisting: 0,
        status: "incomplete",
      },
      {
        intent: "Other",
        id: OTH,
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        status: "not_attempted",
      },
    ]);
  });

  it("adds sentences and spreads the result at the top level", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      mode: "add",
      entries: [
        { intent: "Tag", sentences: [`${SENTINEL} n1`, `${SENTINEL} n2`] },
      ],
    });
    expect(p.writes()).toEqual([
      {
        method: "patch",
        path: sentPath(TAG),
        body: {
          operations: [
            { op: "create", value: { text: `${SENTINEL} n1` } },
            { op: "create", value: { text: `${SENTINEL} n2` } },
          ],
        },
      },
    ]);
    expect(r).toEqual({
      operation: "import_sentences",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      totals: {
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
        batches: 1,
      },
      intents: [
        {
          intent: "Tag",
          id: TAG,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          status: "ok",
        },
      ],
    });
    expect(r._hints).toBeUndefined();
    noSentence(r);
  });

  it("replaces: deletes absent existing sentences by id, then creates the new one", async () => {
    const p = makePlatform();
    const ids = p.sentenceIds(TAG);
    const r = await call(p, {
      ...base,
      mode: "replace",
      entries: [
        {
          intent: "Family/Group/Tag",
          sentences: [`${SENTINEL} tag 1`, `${SENTINEL} fresh`],
        },
      ],
    });
    expect(p.writes()).toEqual([
      {
        method: "patch",
        path: sentPath(TAG),
        body: {
          operations: [
            { op: "delete", id: ids[1] },
            { op: "delete", id: ids[2] },
            { op: "delete", id: ids[3] },
            { op: "delete", id: ids[4] },
            { op: "create", value: { text: `${SENTINEL} fresh` } },
          ],
        },
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("replace");
    expect(r.totals).toEqual({
      created: 1,
      deleted: 4,
      skippedExisting: 1,
      duplicatesDropped: 0,
      batches: 1,
    });
    noSentence(r);
  });

  it("warns when the import is partial and reports the failed intent", async () => {
    const p = makePlatform();
    p.fail({
      method: "patch",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const r = await call(p, {
      ...base,
      mode: "add",
      entries: [{ intent: "Tag", sentences: [`${SENTINEL} n1`] }],
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("partial");
    expect(r.intents).toEqual([
      {
        intent: "Tag",
        id: TAG,
        created: 0,
        deleted: 0,
        skippedExisting: 0,
        status: "failed",
        httpStatus: 500,
      },
    ]);
    expect(r._hints.warning.length).toBeGreaterThan(0);
    noSecret(r);
    noSentence(r);
  });

  it("returns unresolved_intents with candidates and makes no sentence call", async () => {
    const p = makePlatform({ intents: [...defaultSeed(), ...dupSeeds()] });
    const r = await call(p, {
      ...base,
      mode: "add",
      entries: [
        { intent: "Nope", sentences: [`${SENTINEL} a`] },
        { intent: "Dup", sentences: [`${SENTINEL} b`] },
        { intent: "Tag", sentences: [`${SENTINEL} c`] },
      ],
    });
    expect(r).toEqual({
      operation: "import_sentences",
      flowId: FLOW,
      ok: false,
      error: "unresolved_intents",
      problems: [
        { intent: "Nope", error: "not_found" },
        { intent: "Dup", error: "ambiguous", candidates: [DUP1, DUP2] },
      ],
    });
    expect(p.sentenceCalls()).toEqual([]);
    noWrites(p);
  });

  it("returns sentence_cap_exceeded and sends no PATCH", async () => {
    const p = makePlatform();
    const r = await call(p, {
      ...base,
      mode: "add",
      entries: [
        {
          intent: "Tag",
          sentences: Array.from(
            { length: 196 },
            (_, i) => `${SENTINEL} cap ${i}`,
          ),
        },
      ],
    });
    expect(r).toEqual({
      operation: "import_sentences",
      flowId: FLOW,
      ok: false,
      error: "sentence_cap_exceeded",
      problems: [{ intent: "Tag", id: TAG, wouldHave: 201, cap: 200 }],
    });
    noWrites(p);
    noSentence(r);
  });

  it("reads the tree without counts (no limit 1 sentence requests)", async () => {
    const p = makePlatform();
    await call(p, {
      ...base,
      mode: "add",
      entries: [{ intent: "Tag", sentences: [`${SENTINEL} n1`] }],
    });
    expect(p.sentenceCalls().filter((c) => c.params?.limit === 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
describe("manage_intents build", () => {
  const base = { operation: "build", projectId: PROJECT };

  it("starts a full build, polls the task and reports done", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["queued", "active", "done"]);
    const c = clock();
    const r = await call(p, base, c);
    expect(p.writes()).toEqual([
      {
        method: "post",
        path: TRAIN_PATH,
        body: { localeId: LOC, mode: "full" },
      },
    ]);
    expect(p.gets(taskPath(TASK))).toHaveLength(3);
    expect(p.gets(taskPath(TASK))[0].params).toEqual({ projectId: PROJECT });
    expect(c.sleep.mock.calls.map((x) => x[0])).toEqual([3000, 3000]);
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: true,
      status: "done",
      taskId: TASK,
      currentStep: 1,
      totalStep: 3,
      elapsedMs: 6000,
    });
    expect(r._hints).toBeUndefined();
  });

  it("passes quick mode through", async () => {
    const p = makePlatform();
    await call(p, { ...base, mode: "quick" }, clock());
    expect(p.writes()[0].body).toEqual({ localeId: LOC, mode: "quick" });
  });

  it("defaults to a 60 second deadline and returns pending with a model_state hint", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["active"]);
    const c = clock();
    const r = await call(p, base, c);
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: true,
      status: "pending",
      taskId: TASK,
      currentStep: 1,
      totalStep: 3,
      elapsedMs: 60000,
      _hints: { action: expect.stringContaining("model_state") },
    });
    expect(c.sleep).toHaveBeenCalledTimes(20);
  });

  it("converts waitSeconds to the deadline", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["active"]);
    const c = clock();
    const r = await call(p, { ...base, waitSeconds: 10 }, c);
    expect(r.status).toBe("pending");
    expect(r.elapsedMs).toBe(12000);
    expect(c.sleep).toHaveBeenCalledTimes(4);
  });

  it("treats waitSeconds 0 as a zero deadline, not the default", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["active"]);
    const c = clock();
    const r = await call(p, { ...base, waitSeconds: 0 }, c);
    expect(r.status).toBe("pending");
    expect(r.elapsedMs).toBe(0);
    expect(c.sleep).not.toHaveBeenCalled();
    expect(r._hints.action.length).toBeGreaterThan(0);
  });

  it("passes a failed build through without upstream text", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["error"]);
    const r = await call(p, base, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "build_failed",
      taskId: TASK,
      elapsedMs: 0,
    });
    noSecret(r);
  });

  it("passes a cancelled build through", async () => {
    const p = makePlatform();
    p.setTaskStatuses(["cancelled"]);
    const r = await call(p, base, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "build_cancelled",
      taskId: TASK,
      elapsedMs: 0,
    });
  });

  it("passes build_not_started with the http status when the POST is rejected", async () => {
    const p = makePlatform();
    p.fail({ method: "post", path: new RegExp(`${TRAIN_PATH}$`), status: 409 });
    const r = await call(p, base, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "build_not_started",
      httpStatus: 409,
    });
    noSecret(r);
  });

  it("returns locale_not_found and does not POST when the flow has no locale", async () => {
    const p = makePlatform({ locale: null });
    const r = await call(p, base, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "locale_not_found",
    });
    noWrites(p);
  });
});

// ---------------------------------------------------------------------------
// shared behaviour
// ---------------------------------------------------------------------------
const WRITE_ARGS: Array<[string, Record<string, unknown>]> = [
  ["create", { operation: "create", projectId: PROJECT, name: "X" }],
  [
    "update",
    { operation: "update", projectId: PROJECT, intent: "Group", name: "Y" },
  ],
  [
    "move",
    { operation: "move", projectId: PROJECT, intent: "Tag", parent: null },
  ],
  ["delete", { operation: "delete", projectId: PROJECT, intent: "Tag" }],
  [
    "import_sentences",
    {
      operation: "import_sentences",
      projectId: PROJECT,
      mode: "add",
      entries: [{ intent: "Tag", sentences: [`${SENTINEL} a`] }],
    },
  ],
];

describe("manage_intents tree_incomplete on write", () => {
  it.each(WRITE_ARGS)(
    "%s is refused when the list has an orphan",
    async (_n, args) => {
      const p = makePlatform({ intents: orphanSeed() });
      const r = await call(p, args);
      expect(r).toEqual({
        operation: args.operation,
        error: "tree_incomplete",
      });
      noWrites(p);
      expect(p.sentenceCalls()).toEqual([]);
    },
  );

  it.each(WRITE_ARGS)(
    "%s is refused when the list is truncated",
    async (_n, args) => {
      const p = makePlatform({ pageSize: 2 });
      failNextPage(p);
      const r = await call(p, args);
      expect(r).toEqual({
        operation: args.operation,
        error: "tree_incomplete",
      });
      noWrites(p);
      expect(p.sentenceCalls()).toEqual([]);
    },
  );
});

describe("manage_intents flow_not_readable", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["list", { operation: "list" }],
    ["export_tree", { operation: "export_tree" }],
    ["below_minimum", { operation: "below_minimum" }],
    ["get", { operation: "get", intent: "Tag" }],
    ["compare", { operation: "compare", file: "x.csv" }],
    ...WRITE_ARGS,
  ];
  it.each(cases)(
    "%s returns flow_not_readable on a failed first page",
    async (_n, args) => {
      const p = makePlatform();
      p.fail({ method: "get", path: new RegExp(`${LIST_PATH}$`), status: 503 });
      const readFile = reader(csv([["Family", "csvone"]]));
      const r = await call(p, args, { readFile });
      expect(r).toMatchObject({
        operation: args.operation,
        error: "flow_not_readable",
        httpStatus: 503,
      });
      noSecret(r);
      noWrites(p);
    },
  );
});

describe("manage_intents request_failed", () => {
  const cases: Array<[string, Record<string, unknown>, Failure]> = [
    [
      "create",
      { operation: "create", projectId: PROJECT, name: "X" },
      { method: "post", path: new RegExp(`${LIST_PATH}$`), status: 400 },
    ],
    [
      "update",
      { operation: "update", projectId: PROJECT, intent: "Group", name: "Y" },
      { method: "patch", path: new RegExp(`/${GRP}$`), status: 400 },
    ],
    [
      "move",
      { operation: "move", projectId: PROJECT, intent: "Tag", parent: null },
      { method: "patch", path: new RegExp(`/${TAG}$`), status: 400 },
    ],
    [
      "delete",
      { operation: "delete", projectId: PROJECT, intent: "Tag" },
      { method: "delete", path: new RegExp(`/${TAG}$`), status: 400 },
    ],
    [
      "model_state",
      { operation: "model_state" },
      { method: "get", path: new RegExp(`${FLOW_PATH}$`), status: 400 },
    ],
  ];

  it.each(cases)(
    "%s becomes request_failed with the status and a fixed hint",
    async (_n, args, f) => {
      const p = makePlatform();
      p.fail(f);
      const r = await call(p, args);
      expect(r).toEqual({
        operation: args.operation,
        error: "request_failed",
        httpStatus: 400,
        _hints: { action: expect.any(String) },
      });
      expect(r._hints.action.length).toBeGreaterThan(0);
      noSecret(r);
    },
  );

  it("omits httpStatus when the rejection carries no numeric status", async () => {
    const p = makePlatform();
    p.fail({ method: "delete", path: new RegExp(`/${TAG}$`) });
    const r = await call(p, {
      operation: "delete",
      projectId: PROJECT,
      intent: "Tag",
    });
    expect(r.error).toBe("request_failed");
    expect("httpStatus" in r && r.httpStatus !== undefined).toBe(false);
    noSecret(r);
  });

  it("omits httpStatus when the status is not a number", async () => {
    const p = makePlatform();
    p.fail({ method: "delete", path: new RegExp(`/${TAG}$`), status: "500" });
    const r = await call(p, {
      operation: "delete",
      projectId: PROJECT,
      intent: "Tag",
    });
    expect(r.error).toBe("request_failed");
    expect(r.httpStatus).toBeUndefined();
  });
});

describe("manage_intents http status shapes", () => {
  const delTag = { operation: "delete", projectId: PROJECT, intent: "Tag" };
  const tagPath = new RegExp(`/${TAG}$`);

  it("request_failed reports a status carried as err.status with no response", async () => {
    const p = makePlatform();
    p.fail({ method: "delete", path: tagPath, status: 404, shape: "plain" });
    const r = await call(p, delTag);
    expect(r).toEqual({
      operation: "delete",
      error: "request_failed",
      httpStatus: 404,
      _hints: { action: expect.any(String) },
    });
    noSecret(r);
  });

  it("err.response.status wins when both shapes carry a status", async () => {
    const p = makePlatform();
    p.fail({ method: "delete", path: tagPath, status: 500, shape: "both" });
    const r = await call(p, delTag);
    expect(r.httpStatus).toBe(500);
  });

  it("flow_not_readable reports err.status on the first list page", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`${LIST_PATH}$`),
      status: 502,
      shape: "plain",
    });
    const r = await call(p, { operation: "list" });
    expect(r).toMatchObject({
      operation: "list",
      error: "flow_not_readable",
      httpStatus: 502,
    });
    noSecret(r);
  });

  it("flow_not_readable reports err.status when the project-check flow GET rejects", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`${FLOW_PATH}$`),
      status: 504,
      shape: "plain",
    });
    const r = await call(p, delTag);
    expect(r).toMatchObject({
      operation: "delete",
      error: "flow_not_readable",
      httpStatus: 504,
    });
    noWrites(p);
  });

  it("get reports err.status for a failed request", async () => {
    const p = makePlatform();
    p.fail({
      method: "get",
      path: new RegExp(`/${GRP}/sentences$`),
      status: 429,
      shape: "plain",
    });
    const r = await call(p, { operation: "get", intent: "Group" });
    expect(r.error).toBe("request_failed");
    expect(r.httpStatus).toBe(429);
  });

  it("a failed import intent reports err.status", async () => {
    const p = makePlatform();
    p.fail({
      method: "patch",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 413,
      shape: "plain",
    });
    const r = await call(p, {
      operation: "import_sentences",
      projectId: PROJECT,
      mode: "add",
      entries: [{ intent: "Tag", sentences: [`${SENTINEL} n1`] }],
    });
    expect(r.intents[0].status).toBe("failed");
    expect(r.intents[0].httpStatus).toBe(413);
    noSecret(r);
  });

  it("build_not_started reports err.status", async () => {
    const p = makePlatform();
    p.fail({
      method: "post",
      path: new RegExp(`${TRAIN_PATH}$`),
      status: 423,
      shape: "plain",
    });
    const r = await call(
      p,
      { operation: "build", projectId: PROJECT },
      clock(),
    );
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "build_not_started",
      httpStatus: 423,
    });
  });
});

describe("manage_intents project check on writes", () => {
  const ALL_WRITES: Array<[string, Record<string, unknown>]> = [
    ...WRITE_ARGS,
    ["build", { operation: "build", projectId: PROJECT }],
  ];

  it.each(ALL_WRITES)(
    "%s is refused with project_mismatch when the flow belongs to another project",
    async (_n, args) => {
      const p = makePlatform({ projectRef: hid("e", 2) });
      const r = await call(p, args, clock());
      expect(r).toEqual({
        operation: args.operation,
        error: "project_mismatch",
      });
      noWrites(p);
      expect(p.gets(LIST_PATH)).toEqual([]);
      expect(p.sentenceCalls()).toEqual([]);
    },
  );

  it.each(ALL_WRITES)(
    "%s is refused with project_mismatch when the flow has no projectReference",
    async (_n, args) => {
      const p = makePlatform({ projectRef: null });
      const r = await call(p, args, clock());
      expect(r).toEqual({
        operation: args.operation,
        error: "project_mismatch",
      });
      noWrites(p);
      expect(p.gets(LIST_PATH)).toEqual([]);
    },
  );

  it.each(ALL_WRITES)(
    "%s returns flow_not_readable when the flow GET rejects",
    async (_n, args) => {
      const p = makePlatform();
      p.fail({ method: "get", path: new RegExp(`${FLOW_PATH}$`), status: 503 });
      const r = await call(p, args, clock());
      expect(r).toMatchObject({
        operation: args.operation,
        error: "flow_not_readable",
        httpStatus: 503,
      });
      noSecret(r);
      noWrites(p);
      expect(p.gets(LIST_PATH)).toEqual([]);
    },
  );

  it.each([
    ["create", { operation: "create", projectId: PROJECT, name: "Fresh" }],
    ["build", { operation: "build", projectId: PROJECT }],
  ] as Array<[string, Record<string, unknown>]>)(
    "%s reads the flow exactly once",
    async (_n, args) => {
      const p = makePlatform();
      await call(p, args, clock());
      expect(p.gets(FLOW_PATH)).toHaveLength(1);
    },
  );

  it("build takes localeId from that single flow read", async () => {
    const p = makePlatform();
    await call(p, { operation: "build", projectId: PROJECT }, clock());
    expect(p.writes()[0].body).toEqual({ localeId: LOC, mode: "full" });
  });

  it("the project check comes before the tree read", async () => {
    const p = makePlatform();
    await call(p, { operation: "delete", projectId: PROJECT, intent: "Tag" });
    expect(p.calls[0]).toEqual({ method: "get", path: FLOW_PATH });
  });
});

describe("manage_intents read operations never write", () => {
  const reads: Array<[string, Record<string, unknown>]> = [
    ["list", { operation: "list", includeStatus: true }],
    ["get", { operation: "get", intent: "Group", includeSentences: true }],
    ["export_tree", { operation: "export_tree" }],
    ["below_minimum", { operation: "below_minimum" }],
    ["compare", { operation: "compare", file: "x.csv" }],
    ["model_state", { operation: "model_state" }],
  ];
  it.each(reads)("%s makes only GET calls", async (_n, args) => {
    const p = makePlatform();
    const readFile = reader(csv([["Family", "csvone"]]));
    const r = await call(p, args, { readFile });
    expect(r.operation).toBe(args.operation);
    expect(r.error).toBeUndefined();
    noWrites(p);
  });
});

describe("manage_intents privacy", () => {
  const all: Array<[string, Record<string, unknown>]> = [
    ["list", { operation: "list", includeStatus: true }],
    ["get", { operation: "get", intent: "Group" }],
    ["export_tree", { operation: "export_tree" }],
    ["below_minimum", { operation: "below_minimum", min: 7 }],
    ["compare", { operation: "compare", file: "x.csv" }],
    ["model_state", { operation: "model_state" }],
    [
      "create",
      {
        operation: "create",
        projectId: PROJECT,
        name: "Fresh",
        sentences: [`${SENTINEL} new 1`],
      },
    ],
    [
      "update",
      { operation: "update", projectId: PROJECT, intent: "Group", name: "Z" },
    ],
    [
      "move",
      { operation: "move", projectId: PROJECT, intent: "Tag", parent: null },
    ],
    ["delete", { operation: "delete", projectId: PROJECT, intent: "Tag" }],
    [
      "import add",
      {
        operation: "import_sentences",
        projectId: PROJECT,
        mode: "add",
        entries: [{ intent: "Tag", sentences: [`${SENTINEL} new 1`] }],
      },
    ],
    [
      "import replace",
      {
        operation: "import_sentences",
        projectId: PROJECT,
        mode: "replace",
        entries: [{ intent: "Tag", sentences: [`${SENTINEL} new 1`] }],
      },
    ],
    ["build", { operation: "build", projectId: PROJECT }],
  ];
  it.each(all)(
    "%s result never contains a platform sentence",
    async (_n, args) => {
      const p = makePlatform();
      const readFile = reader(csv([["Family", "csvone"]]));
      const r = await call(p, args, { readFile, ...clock() });
      expect(r.operation).toBe(args.operation);
      noSentence(r);
      noSecret(r);
    },
  );

  it("get with includeSentences is the only result that carries sentence text", async () => {
    const p = makePlatform();
    const r = await call(p, {
      operation: "get",
      intent: "Group",
      includeSentences: true,
    });
    expect(JSON.stringify(r)).toContain(`${SENTINEL} grp 1`);
  });
});

describe("manage_intents schema failures throw", () => {
  it("throws on a write without projectId and makes no call", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, {
        operation: "create",
        flowId: FLOW,
        name: "X",
      }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });

  it("throws on an unknown operation", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, { operation: "explode", flowId: FLOW }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });

  it("throws on a malformed flowId", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, { operation: "list", flowId: "not-an-id" }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });

  it("throws on an update that changes nothing", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, {
        operation: "update",
        flowId: FLOW,
        projectId: PROJECT,
        intent: "Group",
      }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });

  it("throws on a move without a parent key", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, {
        operation: "move",
        flowId: FLOW,
        projectId: PROJECT,
        intent: "Tag",
      }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });

  it("throws on an import without a mode", async () => {
    const p = makePlatform();
    await expect(
      handleManageIntents(p.api, {
        operation: "import_sentences",
        flowId: FLOW,
        projectId: PROJECT,
        entries: [{ intent: "Tag", sentences: ["a"] }],
      }),
    ).rejects.toThrow();
    expect(p.calls).toEqual([]);
  });
});

describe("manage_intents whitespace in platform-side names", () => {
  const spaced = (name: string): SeedIntent[] =>
    defaultSeed().map((s) => (s.id === TAG ? { ...s, name } : s));

  it("compare lists an uncounted intent named 'Tag ' and does not report 'Tag' missing", async () => {
    const p = makePlatform({ intents: spaced("Tag ") });
    p.fail({
      method: "get",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const r = await call(
      p,
      { operation: "compare", file: "x.csv" },
      { readFile: reader(csv([["Tag", "csvtag"]])) },
    );
    expect(r.countsIncomplete).toBe(true);
    expect(r.uncountedIntents.map((n: string) => n.trim())).toEqual(["Tag"]);
    expect(r.uncountedIntents).toHaveLength(1);
    expect(r.report.missing).toEqual([]);
    expect(r.report.extra).toEqual(["Family", "Group", "Other"]);
  });

  it("below_minimum lists an uncounted intent named 'Tag ' as uncounted", async () => {
    const p = makePlatform({ intents: spaced("Tag ") });
    p.fail({
      method: "get",
      path: new RegExp(`/${TAG}/sentences$`),
      status: 500,
    });
    const r = await call(p, { operation: "below_minimum" });
    expect(r.countsIncomplete).toBe(true);
    expect(r.uncountedIntents.map((n: string) => n.trim())).toEqual(["Tag"]);
    expect(r.uncountedIntents).toHaveLength(1);
    expect(r.intents.map((i: any) => i.name.trim())).not.toContain("Tag");
  });

  const pairs: Array<[string, string, string]> = [
    ["existing has trailing space", "Billing ", "Billing"],
    ["call has surrounding spaces", "Billing", " Billing "],
  ];

  describe.each(pairs)("%s", (_label, existing, called) => {
    const EXISTING = hid("a", 7);
    const MOVER = hid("a", 8);

    it("create refuses with name_exists and writes nothing", async () => {
      const p = makePlatform({
        intents: [
          ...defaultSeed(),
          { id: EXISTING, name: existing, parent: null, sentences: [] },
        ],
      });
      const r = await call(p, {
        operation: "create",
        projectId: PROJECT,
        name: called,
      });
      expect(r).toEqual({
        operation: "create",
        error: "name_exists",
        id: EXISTING,
      });
      noWrites(p);
    });

    it("update (rename) refuses with name_exists and writes nothing", async () => {
      const p = makePlatform({
        intents: [
          ...defaultSeed(),
          { id: EXISTING, name: existing, parent: null, sentences: [] },
        ],
      });
      const r = await call(p, {
        operation: "update",
        projectId: PROJECT,
        intent: "Other",
        name: called,
      });
      expect(r).toEqual({
        operation: "update",
        error: "name_exists",
        id: EXISTING,
      });
      noWrites(p);
    });

    it("move refuses with name_exists and writes nothing", async () => {
      const p = makePlatform({
        intents: [
          ...defaultSeed(),
          { id: EXISTING, name: existing, parent: OTH, sentences: [] },
          { id: MOVER, name: called, parent: FAM, sentences: [] },
        ],
      });
      const r = await call(p, {
        operation: "move",
        projectId: PROJECT,
        intent: MOVER,
        parent: "Other",
      });
      expect(r).toEqual({
        operation: "move",
        error: "name_exists",
        id: EXISTING,
      });
      noWrites(p);
    });
  });
});

describe("manage_intents build with an unusable locale", () => {
  const args = { operation: "build", projectId: PROJECT };
  const cases: Array<[string, unknown]> = [
    ["an empty string", ""],
    ["a number", 42],
  ];

  it.each(cases)("returns locale_not_found for %s", async (_n, locale) => {
    const p = makePlatform();
    p.respond("get", new RegExp(`${FLOW_PATH}$`), {
      _id: FLOW,
      projectReference: PROJECT,
      localeReference: locale,
    });
    const r = await call(p, args, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "locale_not_found",
    });
    noWrites(p);
    expect(p.calls.filter((c) => c.path.includes("/tasks/"))).toEqual([]);
    expect(p.gets(FLOW_PATH)).toHaveLength(1);
  });

  it("returns locale_not_found when the locale is absent, after passing the project check", async () => {
    const p = makePlatform({ locale: null });
    const r = await call(p, args, clock());
    expect(r).toEqual({
      operation: "build",
      flowId: FLOW,
      ok: false,
      error: "locale_not_found",
    });
    noWrites(p);
    expect(p.calls.filter((c) => c.path.includes("/tasks/"))).toEqual([]);
    expect(p.gets(FLOW_PATH)).toHaveLength(1);
  });
});

describe("manage_intents operation field", () => {
  it("sets operation on every error shape", async () => {
    const p = makePlatform();
    const a = await call(p, { operation: "get", intent: "Nope" });
    const b = await call(p, {
      operation: "delete",
      projectId: PROJECT,
      intent: "Family",
    });
    expect(a.operation).toBe("get");
    expect(b.operation).toBe("delete");
  });
});
