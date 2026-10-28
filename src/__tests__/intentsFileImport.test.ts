import { describe, expect, it, jest } from "@jest/globals";
import type { IntentApi } from "../tools/intents/types.js";
import { FileAccessError } from "../utils/fileAccess.js";
import { importCsv, importTree } from "../tools/intents/fileImport.js";

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const FLOW = "ffffffffffffffffffffff01";
const id = (n: number): string => "a".repeat(22) + String(n).padStart(2, "0");
/** Id the fake gives to the n-th successful intent creation (1-based). */
const cid = (n: number): string =>
  "e".repeat(18) + n.toString(16).padStart(6, "0");

const ALPHA = id(1);
const BETA = id(2);
const TWIN1 = id(5);
const TWIN2 = id(6);

const LIST_PATH = `/v2.0/flows/${FLOW}/intents`;
const SENT_PATH = (intentId: string): string =>
  `/v2.0/flows/${FLOW}/intents/${intentId}/sentences`;
const ONE_PATH = (intentId: string): string =>
  `/v2.0/flows/${FLOW}/intents/${intentId}`;

const SENTINEL_ERR = "SENTINEL_UPSTREAM_ERROR_TEXT_58";
const SENTINEL_SENTENCE = "SENTINEL_SENTENCE_TEXT_31";

const HINTS = {
  warning: expect.stringMatching(/\S/),
  action: expect.stringContaining("run the same call again"),
};

interface Call {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  params?: Record<string, unknown>;
  body?: any;
}

interface SeedIntent {
  id: string;
  name: string;
  parentId?: string | null;
  childFeatures?: boolean;
  sentences?: string[];
}

interface FakeCfg {
  intents?: SeedIntent[];
  pageSize?: number;
  listError?: Error;
  /** n is the 1-based POST attempt number. */
  postFail?: (
    body: any,
    n: number,
  ) => Error | "noid" | "numericid" | { response: unknown } | undefined;
  failPatch?: (intentId: string, patchNo: number) => Error | undefined;
  onPost?: (n: number) => void;
  onSentenceGet?: () => void;
  onPatch?: () => void;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    response: { status, data: { message } },
  });
}
function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function makeFake(cfg: FakeCfg = {}) {
  const calls: Call[] = [];
  const intents = new Map<
    string,
    {
      id: string;
      name: string;
      parentId: string | null;
      childFeatures: boolean;
    }
  >();
  const sentences = new Map<string, Array<{ _id: string; text: string }>>();
  let sentenceSeq = 0;
  for (const s of cfg.intents ?? []) {
    intents.set(s.id, {
      id: s.id,
      name: s.name,
      parentId: s.parentId ?? null,
      childFeatures: s.childFeatures ?? false,
    });
    sentences.set(
      s.id,
      (s.sentences ?? []).map((text) => ({
        _id: `${s.id}-s${sentenceSeq++}`,
        text,
      })),
    );
  }
  let postAttempts = 0;
  let created = 0;
  const patchCounts = new Map<string, number>();

  const get = jest.fn<IntentApi["get"]>(async (path, config) => {
    calls.push({ method: "get", path, params: config?.params });
    if (path === LIST_PATH) {
      if (cfg.listError) throw cfg.listError;
      const all = [...intents.values()];
      const base =
        config?.params?.includeChildren === true
          ? all
          : all.filter((i) => i.parentId === null);
      const offset = config?.params?.next ? Number(config.params.next) : 0;
      const size = cfg.pageSize ?? 100;
      const end = Math.min(offset + size, base.length);
      return {
        items: base.slice(offset, end).map((i) => ({
          _id: i.id,
          name: i.name,
          parentIntentId: i.parentId,
        })),
        total: base.length,
        nextCursor: end < base.length ? String(end) : null,
      };
    }
    let m = /^\/v2\.0\/flows\/[^/]+\/intents\/([^/]+)\/sentences$/.exec(path);
    if (m) {
      cfg.onSentenceGet?.();
      const list = sentences.get(m[1]) ?? [];
      if (config?.params?.limit === 1) {
        return { items: list.slice(0, 1), total: list.length };
      }
      const offset = config?.params?.next ? Number(config.params.next) : 0;
      const end = Math.min(offset + 100, list.length);
      return {
        items: list.slice(offset, end).map((s) => ({ ...s })),
        nextCursor: end < list.length ? String(end) : null,
      };
    }
    m = /^\/v2\.0\/flows\/[^/]+\/intents\/([^/]+)$/.exec(path);
    if (m) {
      const it = intents.get(m[1]);
      return { _id: m[1], childFeatures: it?.childFeatures ?? false };
    }
    throw new Error(`unexpected GET ${path}`);
  });

  const post = jest.fn<IntentApi["post"]>(async (path, body) => {
    calls.push({ method: "post", path, body });
    if (path !== LIST_PATH) throw new Error(`unexpected POST ${path}`);
    postAttempts++;
    cfg.onPost?.(postAttempts);
    const fail = cfg.postFail?.(body, postAttempts);
    if (fail instanceof Error) throw fail;
    if (fail && typeof fail === "object" && "response" in fail) {
      return fail.response as any;
    }
    if (fail === "noid") return {};
    if (fail === "numericid") return { _id: 12345 };
    created++;
    const newId = cid(created);
    intents.set(newId, {
      id: newId,
      name: body.name,
      parentId: body.parentIntentId ?? null,
      childFeatures: body.childFeatures === true,
    });
    sentences.set(newId, []);
    return { _id: newId, name: body.name };
  });

  const patch = jest.fn<IntentApi["patch"]>(async (path, body) => {
    calls.push({ method: "patch", path, body });
    const m = /^\/v2\.0\/flows\/[^/]+\/intents\/([^/]+)\/sentences$/.exec(path);
    if (!m) throw new Error(`unexpected PATCH ${path}`);
    const intentId = m[1];
    const n = (patchCounts.get(intentId) ?? 0) + 1;
    patchCounts.set(intentId, n);
    const err = cfg.failPatch?.(intentId, n);
    if (err) throw err;
    const list = sentences.get(intentId) ?? [];
    for (const op of body.operations) {
      if (op.op === "create") {
        list.push({ _id: `n-${sentenceSeq++}`, text: op.value.text });
      } else if (op.op === "delete") {
        const i = list.findIndex((s) => s._id === op.id);
        if (i >= 0) list.splice(i, 1);
      }
    }
    sentences.set(intentId, list);
    cfg.onPatch?.();
    return {};
  });

  const del = jest.fn<IntentApi["delete"]>(async (path) => {
    calls.push({ method: "delete", path });
    return {};
  });

  const api: IntentApi = { get, post, patch, delete: del };
  const only = (m: Call["method"]) => calls.filter((c) => c.method === m);
  return {
    api,
    calls,
    intents,
    posts: () => only("post"),
    patches: () => only("patch"),
    writes: () => calls.filter((c) => c.method !== "get"),
    listGets: () =>
      calls.filter((c) => c.method === "get" && c.path === LIST_PATH),
    sentenceGets: () =>
      calls.filter((c) => c.method === "get" && c.path.endsWith("/sentences")),
    oneGets: () =>
      calls.filter(
        (c) =>
          c.method === "get" &&
          c.path !== LIST_PATH &&
          !c.path.endsWith("/sentences"),
      ),
    ops: (c: Call) => c.body.operations as Array<Record<string, any>>,
    texts: (intentId: string) =>
      (sentences.get(intentId) ?? []).map((s) => s.text),
  };
}

const quote = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const csv = (rows: Array<[string, string]>): string =>
  rows.map(([i, s]) => `${quote(i)},exampleSentence,${quote(s)}`).join("\n");
const gen = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix} sample ${i + 1}`);
const rowsFor = (intent: string, texts: string[]): Array<[string, string]> =>
  texts.map((t) => [intent, t]);
const create = (text: string) => ({ op: "create", value: { text } });

function readerFor(files: Record<string, string | Error>) {
  return async (path: string): Promise<string> => {
    const f = files[path];
    if (f === undefined) throw new Error(`no such fixture ${path}`);
    if (f instanceof Error) throw f;
    return f;
  };
}

const spec = (families: any[]): string => JSON.stringify({ families });
/** F1 > [G1 > [t1,t2], G2 > [t3]], F2 > [G3 > [t4]]  (every name is unique across the whole spec) */
const BIG_SPEC = spec([
  {
    name: "F1",
    groups: [
      { name: "G1", tags: ["t1", "t2"] },
      { name: "G2", tags: ["t3"] },
    ],
  },
  { name: "Family two", intent: "F2", groups: [{ name: "G3", tags: ["t4"] }] },
]);

/** The action hint when at least one failed create answered HTTP 409 (exact text). */
const ACTION_409 =
  "Check the counts and names, then run the same call again; what is already there is skipped. A 409 means the name already exists elsewhere in this flow; intent names must be unique across the whole flow (case-sensitive).";
const SMALL_SPEC = spec([
  { name: "F1", groups: [{ name: "G1", tags: ["t1", "t2"] }] },
]);

const csvRun = (
  cfg: FakeCfg,
  text: string,
  extra: Partial<Parameters<typeof importCsv>[2]> & {
    mode?: "add" | "replace";
    createMissing?: boolean;
    deadlineSeconds?: number;
  } = {},
  fake = makeFake(cfg),
) => {
  const { mode, createMissing, deadlineSeconds, ...deps } = extra;
  const args: any = { flowId: FLOW, file: "data.csv", mode: mode ?? "add" };
  if (createMissing !== undefined) args.createMissing = createMissing;
  if (deadlineSeconds !== undefined) args.deadlineSeconds = deadlineSeconds;
  return {
    fake,
    run: () =>
      importCsv(fake.api, args, {
        readFile: readerFor({ "data.csv": text }),
        ...deps,
      }) as Promise<any>,
  };
};

const treeRun = (
  cfg: FakeCfg,
  specText: string,
  csvText: string | undefined,
  extra: Partial<Parameters<typeof importTree>[2]> & {
    mode?: "add" | "replace";
    deadlineSeconds?: number;
  } = {},
  fake = makeFake(cfg),
) => {
  const { mode, deadlineSeconds, ...deps } = extra;
  const args: any = { flowId: FLOW, specFile: "spec.json" };
  if (csvText !== undefined) args.sentencesFile = "data.csv";
  if (mode !== undefined) args.mode = mode;
  if (deadlineSeconds !== undefined) args.deadlineSeconds = deadlineSeconds;
  const files: Record<string, string> = { "spec.json": specText };
  if (csvText !== undefined) files["data.csv"] = csvText;
  return {
    fake,
    run: () =>
      importTree(fake.api, args, {
        readFile: readerFor(files),
        ...deps,
      }) as Promise<any>,
  };
};

const zeroSentences = (rows: number) => ({
  rows,
  created: 0,
  deleted: 0,
  skippedExisting: 0,
  duplicatesDropped: 0,
});

// ---------------------------------------------------------------------------
// import_csv: refusals
// ---------------------------------------------------------------------------

describe("importCsv: refusals make no write call", () => {
  it("maps a FileAccessError to file_error and makes no api call at all", async () => {
    const fake = makeFake();
    const result = await importCsv(
      fake.api,
      { flowId: FLOW, file: "data.csv", mode: "add" },
      {
        readFile: async () => {
          throw new FileAccessError("fixed refusal text", "outside_root");
        },
      },
    );
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "file_error",
      which: "file",
      code: "outside_root",
      message: "fixed refusal text",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses bad rows with the total count and the first 20 line numbers", async () => {
    const lines = [
      ...Array.from({ length: 25 }, (_, i) => `Alpha,exampleSentence`),
      `Alpha,exampleSentence,${SENTINEL_SENTENCE}`,
    ];
    const { fake, run } = csvRun({}, lines.join("\n"));
    const result = await run();
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "csv_errors",
      which: "file",
      count: 25,
      first: Array.from({ length: 20 }, (_, i) => ({
        line: i + 1,
        error: "wrong_column_count",
      })),
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SENTENCE);
    expect(fake.calls).toEqual([]);
  });

  it("reports mixed row errors in file order", async () => {
    const { fake, run } = csvRun(
      {},
      [
        "Alpha,exampleSentence,fine",
        "Alpha,other,wrong column two",
        "Alpha,exampleSentence",
      ].join("\n"),
    );
    const result = await run();
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "csv_errors",
      which: "file",
      count: 2,
      first: [
        { line: 2, error: "unexpected_column_2" },
        { line: 3, error: "wrong_column_count" },
      ],
    });
    expect(fake.writes()).toEqual([]);
  });

  it.each([[""], ["\n  \n\n"]])(
    "refuses a file with no rows (%j) as empty_file",
    async (text) => {
      const { fake, run } = csvRun({}, text);
      expect(await run()).toStrictEqual({
        operation: "import_csv",
        flowId: FLOW,
        error: "empty_file",
        which: "file",
      });
      expect(fake.calls).toEqual([]);
    },
  );

  it("refuses the whole call when a name is ambiguous, listing every ambiguous name with candidates, and creates nothing", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: TWIN1, name: "Twin" },
          { id: TWIN2, name: "Twin" },
          { id: id(7), name: "Pair" },
          { id: id(8), name: "Pair" },
        ],
      },
      csv([
        ...rowsFor("Alpha", ["a sample 1"]),
        ...rowsFor("Twin", ["t sample 1"]),
        ...rowsFor("Gone", ["g sample 1"]),
        ...rowsFor("Pair", ["p sample 1"]),
      ]),
    );
    expect(await run()).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "ambiguous_intents",
      count: 2,
      problems: [
        { intent: "Twin", candidates: [TWIN1, TWIN2] },
        { intent: "Pair", candidates: [id(7), id(8)] },
      ],
    });
    expect(fake.writes()).toEqual([]);
    expect(fake.sentenceGets()).toEqual([]);
    expect(fake.listGets()).toHaveLength(1);
  });

  it("does not refuse for an ambiguous name that is over the cap: it is skipped as overCap", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: TWIN1, name: "Twin" },
          { id: TWIN2, name: "Twin" },
          { id: BETA, name: "Beta" },
        ],
      },
      csv([
        ...rowsFor("Twin", gen("twin", 201)),
        ...rowsFor("Beta", ["b sample 1"]),
      ]),
    );
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.skipped).toStrictEqual({ overCap: 1 });
    expect(result.names).toStrictEqual({ overCap: ["Twin"] });
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(BETA)]);
  });

  it.each([
    ["err.response.status", (m: string) => httpError(500, m)],
    ["err.status", (m: string) => statusError(500, m)],
  ])(
    "returns flow_not_readable with httpStatus via %s and never the upstream text",
    async (_label, mk) => {
      const { fake, run } = csvRun(
        { listError: mk(SENTINEL_ERR) },
        csv(rowsFor("Alpha", ["a sample 1"])),
      );
      const result = await run();
      expect(result).toStrictEqual({
        operation: "import_csv",
        flowId: FLOW,
        error: "flow_not_readable",
        httpStatus: 500,
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
      expect(fake.writes()).toEqual([]);
    },
  );

  it("returns tree_incomplete for a tree with an orphan and makes no write call", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: BETA, name: "Beta", parentId: id(99) },
        ],
      },
      csv(rowsFor("Alpha", ["a sample 1"])),
    );
    expect(await run()).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "tree_incomplete",
    });
    expect(fake.writes()).toEqual([]);
    expect(fake.sentenceGets()).toEqual([]);
  });

  it("returns tree_incomplete for a truncated read (cursor still present after 20 pages)", async () => {
    const seeded = Array.from({ length: 21 }, (_, i) => ({
      id: id(i + 1),
      name: `Intent ${i + 1}`,
    }));
    const { fake, run } = csvRun(
      { intents: seeded, pageSize: 1 },
      csv(rowsFor("Intent 1", ["a sample 1"])),
    );
    expect(await run()).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      error: "tree_incomplete",
    });
    expect(fake.listGets()).toHaveLength(20);
    expect(fake.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// import_csv: working paths
// ---------------------------------------------------------------------------

describe("importCsv: existing and missing intents", () => {
  it("imports into existing intents with one tree read, no creation, exact result shape", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha", sentences: ["unrelated"] },
          { id: BETA, name: "Beta" },
        ],
      },
      csv([
        ...rowsFor("Alpha", ["a sample 1", "a sample 2", "a sample 3"]),
        ...rowsFor("Beta", ["b sample 1", "b sample 2"]),
      ]),
    );
    const result = await run();
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 5,
        created: 5,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 2,
    });
    expect(fake.listGets().map((c) => c.params)).toEqual([
      { limit: 100, includeChildren: true },
    ]);
    expect(fake.posts()).toEqual([]);
    expect(fake.texts(ALPHA)).toEqual([
      "unrelated",
      "a sample 1",
      "a sample 2",
      "a sample 3",
    ]);
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENT_PATH(ALPHA),
      SENT_PATH(BETA),
    ]);
  });

  it("creates missing intents as flat roots with body exactly {name}, in file order, then imports in file order", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv([
        ["Newone", "n sample 1"],
        ["Alpha", "a sample 1"],
        ["Another", "x sample 1"],
        ["Newone", "n sample 2"],
      ]),
    );
    const result = await run();
    expect(fake.posts().map((c) => [c.path, c.body])).toStrictEqual([
      [LIST_PATH, { name: "Newone" }],
      [LIST_PATH, { name: "Another" }],
    ]);
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENT_PATH(cid(1)),
      SENT_PATH(ALPHA),
      SENT_PATH(cid(2)),
    ]);
    expect(fake.ops(fake.patches()[0])).toEqual([
      create("n sample 1"),
      create("n sample 2"),
    ]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 3, existing: 1, created: 2, createFailed: 0 },
      sentences: {
        rows: 4,
        created: 4,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 3,
    });
    expect(fake.listGets()).toHaveLength(1);
  });

  it("matches names after trimming and exactly (case-sensitive): 'alpha' is a different, missing intent", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv([
        ["  Alpha  ", "a sample 1"],
        ["alpha", "a sample 2"],
      ]),
    );
    const result = await run();
    expect(fake.posts().map((c) => c.body)).toStrictEqual([{ name: "alpha" }]);
    expect(result.intents).toStrictEqual({
      inFile: 2,
      existing: 1,
      created: 1,
      createFailed: 0,
    });
  });

  it("with createMissing false creates nothing and reports the missing intents under skipped.missing (not partial)", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv([
        ...rowsFor("Alpha", ["a sample 1", "a sample 2"]),
        ...rowsFor("Newone", ["n sample 1", "n sample 2", "n sample 3"]),
      ]),
      { createMissing: false },
    );
    const result = await run();
    expect(fake.posts()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 1, created: 0, createFailed: 0 },
      sentences: {
        rows: 5,
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      skipped: { missing: 1 },
      names: { missing: ["Newone"] },
    });
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(ALPHA)]);
  });

  it.each([
    [
      "a rejected POST",
      (_b: any, n: number) =>
        n === 1 ? httpError(500, SENTINEL_ERR) : undefined,
      { "500": 1 },
    ],
    [
      "a response without _id",
      (_b: any, n: number) => (n === 1 ? ("noid" as const) : undefined),
      { none: 1 },
    ],
    [
      "a non-string _id",
      (_b: any, n: number) => (n === 1 ? ("numericid" as const) : undefined),
      { none: 1 },
    ],
  ])(
    "counts %s as createFailed, never attempts its sentences, and still imports the others",
    async (_label, postFail, byStatus) => {
      const { fake, run } = csvRun(
        { intents: [{ id: ALPHA, name: "Alpha" }], postFail },
        csv([
          ["Bad", `${SENTINEL_SENTENCE} 1`],
          ["Good", "g sample 1"],
          ["Alpha", "a sample 1"],
        ]),
      );
      const result = await run();
      expect(fake.posts()).toHaveLength(2);
      expect(fake.sentenceGets().map((c) => c.path)).toEqual([
        SENT_PATH(cid(1)),
        SENT_PATH(ALPHA),
      ]);
      expect(fake.patches().map((c) => c.path)).toEqual([
        SENT_PATH(cid(1)),
        SENT_PATH(ALPHA),
      ]);
      expect(result).toStrictEqual({
        operation: "import_csv",
        flowId: FLOW,
        ok: true,
        mode: "add",
        status: "partial",
        intents: {
          inFile: 3,
          existing: 1,
          created: 1,
          createFailed: 1,
          createFailedByStatus: byStatus,
        },
        sentences: {
          rows: 3,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
        },
        batches: 2,
        names: { createFailed: ["Bad"] },
        _hints: HINTS,
      });
      expect(result._hints.action).not.toContain("409");
      const json = JSON.stringify(result);
      expect(json).not.toContain(SENTINEL_ERR);
      expect(json).not.toContain(SENTINEL_SENTENCE);
    },
  );

  it.each([
    ["err.response.status", (m: string) => httpError(409, m)],
    ["err.status", (m: string) => statusError(409, m)],
  ])(
    "a 409 on a create (%s) is counted under createFailedByStatus and extends only the action hint",
    async (_label, mk) => {
      const text = csv([
        ["Bad", `${SENTINEL_SENTENCE} 1`],
        ["Good", "g sample 1"],
        ["Alpha", "a sample 1"],
      ]);
      const { fake, run } = csvRun(
        {
          intents: [{ id: ALPHA, name: "Alpha" }],
          postFail: (_b, n) => (n === 1 ? mk(SENTINEL_ERR) : undefined),
        },
        text,
      );
      const result = await run();
      const reference = await csvRun(
        {
          intents: [{ id: ALPHA, name: "Alpha" }],
          postFail: (_b, n) =>
            n === 1 ? httpError(500, SENTINEL_ERR) : undefined,
        },
        text,
      ).run();
      expect(fake.posts()).toHaveLength(2);
      expect(result).toStrictEqual({
        operation: "import_csv",
        flowId: FLOW,
        ok: true,
        mode: "add",
        status: "partial",
        intents: {
          inFile: 3,
          existing: 1,
          created: 1,
          createFailed: 1,
          createFailedByStatus: { "409": 1 },
        },
        sentences: {
          rows: 3,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
        },
        batches: 2,
        names: { createFailed: ["Bad"] },
        _hints: { warning: reference._hints.warning, action: ACTION_409 },
      });
      expect(reference._hints.action).not.toBe(ACTION_409);
      const json = JSON.stringify(result);
      expect(json).not.toContain(SENTINEL_ERR);
      expect(json).not.toContain(SENTINEL_SENTENCE);
    },
  );

  it("counts failed creates per status: several 409, a 400, a status-less error and a response without _id", async () => {
    const { fake, run } = csvRun(
      {
        postFail: (_b, n) =>
          [
            httpError(409, SENTINEL_ERR),
            statusError(400, SENTINEL_ERR),
            httpError(409, SENTINEL_ERR),
            new Error(SENTINEL_ERR),
            "noid" as const,
            undefined,
          ][n - 1],
      },
      csv([
        ["M1", "m sample 1"],
        ["M2", "m sample 2"],
        ["M3", "m sample 3"],
        ["M4", "m sample 4"],
        ["M5", "m sample 5"],
        ["M6", "m sample 6"],
      ]),
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(6);
    expect(result.intents).toStrictEqual({
      inFile: 6,
      existing: 0,
      created: 1,
      createFailed: 5,
      createFailedByStatus: { "409": 2, "400": 1, none: 2 },
    });
    expect(result.status).toBe("partial");
    expect(result.names).toStrictEqual({
      createFailed: ["M1", "M2", "M3", "M4", "M5"],
    });
    expect(result._hints.action).toBe(ACTION_409);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("without any 409 the hints stay as before even when other statuses fail", async () => {
    const { run } = csvRun(
      {
        postFail: (_b, n) =>
          n === 1 ? httpError(400, SENTINEL_ERR) : httpError(503, SENTINEL_ERR),
      },
      csv([
        ["M1", "m sample 1"],
        ["M2", "m sample 2"],
      ]),
    );
    const result = await run();
    expect(result.intents.createFailedByStatus).toStrictEqual({
      "400": 1,
      "503": 1,
    });
    expect(result._hints).toStrictEqual(HINTS);
    expect(result._hints.action).not.toContain("409");
    expect(result._hints.action).not.toContain("unique");
  });

  it("does not count intents that were not attempted after the deadline as failed creates", async () => {
    let t = 0;
    const { fake, run } = csvRun(
      {
        intents: [{ id: ALPHA, name: "Alpha" }],
        onPost: () => {
          t = 1000;
        },
        postFail: (_b, n) =>
          n === 1 ? httpError(409, SENTINEL_ERR) : undefined,
      },
      csv([
        ["Alpha", "a sample 1"],
        ["M1", "m sample 1"],
        ["M2", "m sample 2"],
        ["M3", "m sample 3"],
      ]),
      { deadlineSeconds: 1, now: () => t },
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.intents).toStrictEqual({
      inFile: 4,
      existing: 1,
      created: 0,
      createFailed: 1,
      createFailedByStatus: { "409": 1 },
    });
    expect(result._hints.action).toBe(ACTION_409);
  });

  it("a failed sentence import is not a failed create: no createFailedByStatus key", async () => {
    const { run } = csvRun(
      {
        intents: [{ id: ALPHA, name: "Alpha" }],
        failPatch: () => httpError(409, SENTINEL_ERR),
      },
      csv(rowsFor("Alpha", ["a sample 1"])),
    );
    const result = await run();
    expect(result.status).toBe("partial");
    expect(result.intents).toStrictEqual({
      inFile: 1,
      existing: 1,
      created: 0,
      createFailed: 0,
    });
    expect(result._hints.action).not.toContain("409");
  });

  it("caps every names list at 20 (first 20 in file order) while counts stay exact", async () => {
    const names = Array.from(
      { length: 25 },
      (_, i) => `Miss${String(i + 1).padStart(2, "0")}`,
    );
    const { fake, run } = csvRun(
      { postFail: () => httpError(500, SENTINEL_ERR) },
      csv(names.map((n) => [n, "m sample 1"] as [string, string])),
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(25);
    expect(fake.sentenceGets()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        inFile: 25,
        existing: 0,
        created: 0,
        createFailed: 25,
        createFailedByStatus: { "500": 25 },
      },
      sentences: zeroSentences(25),
      batches: 0,
      names: { createFailed: names.slice(0, 20) },
      _hints: HINTS,
    });
  });

  it("does not re-read the tree after creating intents and reads parents' childFeatures once", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha", childFeatures: true },
          { id: id(3), name: "Child", parentId: ALPHA },
        ],
      },
      csv([
        ["Child", "c sample 1"],
        ["Newone", "n sample 1"],
        ["Another", "x sample 1"],
      ]),
    );
    await run();
    expect(fake.listGets()).toHaveLength(1);
    expect(fake.oneGets().map((c) => c.path)).toEqual([ONE_PATH(ALPHA)]);
    expect(fake.posts()).toHaveLength(2);
  });
});

describe("importCsv: caps", () => {
  it("skips an intent with more than 200 distinct sentences (not created, not imported) while the others import", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: BETA, name: "Beta" }] },
      csv([
        ...rowsFor("Huge", gen("huge", 201)),
        // 200 distinct sentences plus 3 repeats: still within the cap
        ...rowsFor("Beta", [
          ...gen("beta", 200),
          "beta sample 1",
          "beta sample 2",
          "beta sample 3",
        ]),
      ]),
    );
    const result = await run();
    expect(fake.posts()).toEqual([]);
    expect(fake.patches()).toHaveLength(4);
    expect(fake.patches().every((c) => c.path === SENT_PATH(BETA))).toBe(true);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 1, created: 0, createFailed: 0 },
      sentences: {
        rows: 404,
        created: 200,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 3,
      },
      batches: 4,
      skipped: { overCap: 1 },
      names: { overCap: ["Huge"] },
    });
  });

  it("skips an existing intent that would end above 200 and retries once with the rest", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha", sentences: gen("old", 195) },
          { id: BETA, name: "Beta" },
        ],
      },
      csv([
        ...rowsFor("Alpha", gen("new", 10)),
        ...rowsFor("Beta", ["b sample 1", "b sample 2"]),
      ]),
    );
    const result = await run();
    // Alpha (195 existing, limit 100) is one full read = 2 page requests (100 + 95), read once in
    // the first pass and not again by the retry. Beta has 0 existing: one page per full read, and
    // it is read in both passes.
    const gets = (p: string) => fake.sentenceGets().filter((c) => c.path === p);
    const fullReads = (p: string) =>
      gets(p).filter((c) => c.params?.next === undefined).length;
    expect(fullReads(SENT_PATH(ALPHA))).toBe(1);
    expect(gets(SENT_PATH(ALPHA))).toHaveLength(2);
    expect(gets(SENT_PATH(ALPHA))[1].params).toEqual({
      limit: 100,
      next: "100",
    });
    expect(fullReads(SENT_PATH(BETA))).toBe(2);
    expect(gets(SENT_PATH(BETA))).toHaveLength(2);
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(BETA)]);
    expect(fake.texts(ALPHA)).toHaveLength(195);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 12,
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      skipped: { capExceeded: 1 },
      names: { capExceeded: ["Alpha"] },
    });
  });

  it("makes no second sentence call when every entry is cap-exceeded", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha", sentences: gen("old", 195) }] },
      csv(rowsFor("Alpha", gen("new", 10))),
    );
    const result = await run();
    // exactly the 2 pages (100 + 95) of the single first pass; no second pass, no PATCH
    expect(fake.sentenceGets().map((c) => c.params)).toEqual([
      { limit: 100 },
      { limit: 100, next: "100" },
    ]);
    expect(fake.patches()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 1, existing: 1, created: 0, createFailed: 0 },
      sentences: zeroSentences(10),
      batches: 0,
      skipped: { capExceeded: 1 },
      names: { capExceeded: ["Alpha"] },
    });
  });
});

describe("importCsv: modes, duplicates, partial results, reruns", () => {
  it("passes mode replace through: deletes sentences not in the file, keeps matching ones", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha", sentences: ["old one", "keep one"] },
        ],
      },
      csv(rowsFor("Alpha", ["keep one", "new one"])),
      { mode: "replace" },
    );
    const result = await run();
    expect(fake.ops(fake.patches()[0])).toEqual([
      { op: "delete", id: `${ALPHA}-s0` },
      create("new one"),
    ]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "replace",
      status: "complete",
      intents: { inFile: 1, existing: 1, created: 0, createFailed: 0 },
      sentences: {
        rows: 2,
        created: 1,
        deleted: 1,
        skippedExisting: 1,
        duplicatesDropped: 0,
      },
      batches: 1,
    });
  });

  it("add mode never deletes sentences that are not in the file", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha", sentences: ["old one"] }] },
      csv(rowsFor("Alpha", ["new one"])),
      { mode: "add" },
    );
    await run();
    expect(fake.ops(fake.patches()[0])).toEqual([create("new one")]);
    expect(fake.texts(ALPHA)).toEqual(["old one", "new one"]);
  });

  it("counts repeated sentences (also after trimming) in duplicatesDropped", async () => {
    const { run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv([
        ["Alpha", "x sample"],
        ["Alpha", "x sample"],
        ["Alpha", "  x sample"],
        ["Alpha", "y sample"],
      ]),
    );
    const result = await run();
    expect(result.sentences).toStrictEqual({
      rows: 4,
      created: 2,
      deleted: 0,
      skippedExisting: 0,
      duplicatesDropped: 2,
    });
  });

  it("reports a failed intent: partial, notDone.failed, names.failed, hints; never upstream text", async () => {
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: BETA, name: "Beta" },
        ],
        failPatch: (intentId) =>
          intentId === BETA ? httpError(500, SENTINEL_ERR) : undefined,
      },
      csv([
        ...rowsFor("Alpha", [`${SENTINEL_SENTENCE} a`]),
        ...rowsFor("Beta", [`${SENTINEL_SENTENCE} b`]),
      ]),
    );
    const result = await run();
    expect(fake.patches()).toHaveLength(2);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 2,
        created: 1,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      notDone: { failed: 1 },
      names: { failed: ["Beta"] },
      _hints: HINTS,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });

  it("a rerun after a partial run continues where it stopped", async () => {
    const cfg: FakeCfg = {
      intents: [
        { id: ALPHA, name: "Alpha" },
        { id: BETA, name: "Beta" },
      ],
      failPatch: (intentId) =>
        intentId === BETA ? httpError(500, SENTINEL_ERR) : undefined,
    };
    const text = csv([
      ...rowsFor("Alpha", ["a sample 1", "a sample 2"]),
      ...rowsFor("Beta", ["b sample 1", "b sample 2"]),
    ]);
    const { fake, run } = csvRun(cfg, text);
    const first = await run();
    expect(first.status).toBe("partial");
    cfg.failPatch = undefined;
    const second = await run();
    expect(second).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 4,
        created: 2,
        deleted: 0,
        skippedExisting: 2,
        duplicatesDropped: 0,
      },
      batches: 1,
    });
    expect(fake.texts(BETA)).toEqual(["b sample 1", "b sample 2"]);
  });

  it("a rerun after a complete run makes no POST and no sentence PATCH", async () => {
    const text = csv([
      ...rowsFor("Alpha", ["a sample 1", "a sample 2"]),
      ...rowsFor("Newone", ["n sample 1"]),
    ]);
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      text,
    );
    const first = await run();
    expect(first.status).toBe("complete");
    expect(fake.posts()).toHaveLength(1);
    expect(fake.patches()).toHaveLength(2);
    const second = await run();
    expect(fake.posts()).toHaveLength(1);
    expect(fake.patches()).toHaveLength(2);
    expect(fake.listGets()).toHaveLength(2);
    expect(second).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 3,
        created: 0,
        deleted: 0,
        skippedExisting: 3,
        duplicatesDropped: 0,
      },
      batches: 0,
    });
  });
});

describe("importCsv: deadline", () => {
  it("stops creating at the deadline; every intent without finished work is notAttempted and nothing is sent", async () => {
    let t = 0;
    const { fake, run } = csvRun(
      {
        intents: [{ id: ALPHA, name: "Alpha" }],
        onPost: () => {
          t = 1000;
        },
      },
      csv([
        ["Alpha", "a sample 1"],
        ["M1", "m sample 1"],
        ["M2", "m sample 2"],
        ["M3", "m sample 3"],
      ]),
      { deadlineSeconds: 1, now: () => t },
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(1);
    expect(fake.sentenceGets()).toEqual([]);
    expect(fake.patches()).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.intents).toStrictEqual({
      inFile: 4,
      existing: 1,
      created: 1,
      createFailed: 0,
    });
    expect(result.notDone).toStrictEqual({ notAttempted: 4 });
    // M2 and M3 were never created: counted in notDone only, not listed in names.
    // Alpha and M1 are listed because the sentence import reports them.
    expect([...result.names.notAttempted].sort()).toEqual(["Alpha", "M1"]);
    expect(Object.keys(result.names)).toEqual(["notAttempted"]);
    expect(result._hints).toStrictEqual(HINTS);
  });

  it("a deadline during the sentence reads marks every intent notAttempted", async () => {
    let t = 0;
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: BETA, name: "Beta" },
        ],
        onSentenceGet: () => {
          t = 1000;
        },
      },
      csv([
        ...rowsFor("Alpha", ["a sample 1"]),
        ...rowsFor("Beta", ["b sample 1"]),
      ]),
      { deadlineSeconds: 1, now: () => t },
    );
    const result = await run();
    expect(fake.patches()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: zeroSentences(2),
      batches: 0,
      notDone: { notAttempted: 2 },
      names: { notAttempted: ["Alpha", "Beta"] },
      _hints: HINTS,
    });
  });

  it("a deadline after the first batch marks the partly written intent incomplete and the untouched one notAttempted", async () => {
    let t = 0;
    const { fake, run } = csvRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: BETA, name: "Beta" },
        ],
        onPatch: () => {
          t = 1000;
        },
      },
      csv([
        ...rowsFor("Alpha", gen("alpha", 120)),
        ...rowsFor("Beta", ["b sample 1"]),
      ]),
      { deadlineSeconds: 1, now: () => t },
    );
    const result = await run();
    expect(fake.patches()).toHaveLength(1);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: { inFile: 2, existing: 2, created: 0, createFailed: 0 },
      sentences: {
        rows: 121,
        created: 50,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      notDone: { incomplete: 1, notAttempted: 1 },
      names: { incomplete: ["Alpha"], notAttempted: ["Beta"] },
      _hints: HINTS,
    });
  });
});

// ---------------------------------------------------------------------------
// import_tree: refusals
// ---------------------------------------------------------------------------

describe("importTree: refusals make no write call", () => {
  it.each([
    ["specFile", "spec.json"],
    ["sentencesFile", "data.csv"],
  ])(
    "maps a FileAccessError on the %s to file_error",
    async (which, failing) => {
      const fake = makeFake();
      const files: Record<string, string | Error> = {
        "spec.json": SMALL_SPEC,
        "data.csv": csv(rowsFor("t1", ["a sample 1"])),
      };
      files[failing] = new FileAccessError("fixed refusal text", "not_found");
      const result = await importTree(
        fake.api,
        { flowId: FLOW, specFile: "spec.json", sentencesFile: "data.csv" },
        { readFile: readerFor(files) },
      );
      expect(result).toStrictEqual({
        operation: "import_tree",
        flowId: FLOW,
        error: "file_error",
        which,
        code: "not_found",
        message: "fixed refusal text",
      });
      expect(fake.writes()).toEqual([]);
      expect(fake.listGets()).toEqual([]);
    },
  );

  it("refuses text that is not JSON as spec_invalid / not_json", async () => {
    const { fake, run } = treeRun({}, "{ not json", undefined);
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "spec_invalid",
      count: 1,
      problems: [{ path: "", reason: "not_json" }],
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a duplicate sibling and reports the path of the second occurrence", async () => {
    const { fake, run } = treeRun(
      {},
      spec([
        {
          name: "F1",
          groups: [
            { name: "G1", tags: ["t1"] },
            { name: "G1", tags: ["t2"] },
          ],
        },
      ]),
      undefined,
    );
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "spec_invalid",
      count: 1,
      problems: [
        { path: "families[0].groups[1]", reason: "duplicate_sibling" },
      ],
    });
    expect(fake.calls).toEqual([]);
  });

  it("reports the total problem count but only the first 20 problems", async () => {
    const tags = Array.from({ length: 25 }, (_, i) => i + 1);
    const { fake, run } = treeRun(
      {},
      spec([{ name: "F1", groups: [{ name: "G1", tags }] }]),
      undefined,
    );
    const result = await run();
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "spec_invalid",
      count: 25,
      problems: Array.from({ length: 20 }, (_, i) => ({
        path: `families[0].groups[0].tags[${i}]`,
        reason: "shape",
      })),
    });
    expect(fake.calls).toEqual([]);
  });

  it("validates the spec first: an invalid spec means the sentences file is not read and no tree read is made", async () => {
    const fake = makeFake();
    const reads: string[] = [];
    const result = await importTree(
      fake.api,
      { flowId: FLOW, specFile: "spec.json", sentencesFile: "data.csv" },
      {
        readFile: async (p) => {
          reads.push(p);
          return p === "spec.json" ? "{ not json" : "Alpha,exampleSentence";
        },
      },
    );
    expect(result.error).toBe("spec_invalid");
    expect(reads).toEqual(["spec.json"]);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["a root that is an array", "[]", [{ path: "", reason: "shape" }]],
    ["a root that is null", "null", [{ path: "", reason: "shape" }]],
    ["a missing families", "{}", [{ path: "families", reason: "shape" }]],
    [
      "an empty families array",
      '{"families":[]}',
      [{ path: "families", reason: "shape" }],
    ],
  ])("reports %s as a single shape problem", async (_l, text, problems) => {
    const { fake, run } = treeRun({}, text, undefined);
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "spec_invalid",
      count: 1,
      problems,
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a bad sentences CSV with which sentencesFile, before any platform call", async () => {
    const { fake, run } = treeRun(
      {},
      SMALL_SPEC,
      ["t1,exampleSentence,ok", "t1,exampleSentence"].join("\n"),
    );
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "csv_errors",
      which: "sentencesFile",
      count: 1,
      first: [{ line: 2, error: "wrong_column_count" }],
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses an empty sentences CSV as empty_file for sentencesFile", async () => {
    const { fake, run } = treeRun({}, SMALL_SPEC, "\n\n");
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "empty_file",
      which: "sentencesFile",
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["err.response.status", (m: string) => httpError(503, m)],
    ["err.status", (m: string) => statusError(503, m)],
  ])("returns flow_not_readable with httpStatus via %s", async (_l, mk) => {
    const { fake, run } = treeRun(
      { listError: mk(SENTINEL_ERR) },
      SMALL_SPEC,
      undefined,
    );
    const result = await run();
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "flow_not_readable",
      httpStatus: 503,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
    expect(fake.writes()).toEqual([]);
  });

  it("returns tree_incomplete for an orphan and makes no write call", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: ALPHA, name: "Alpha" },
          { id: BETA, name: "Beta", parentId: id(99) },
        ],
      },
      SMALL_SPEC,
      undefined,
    );
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "tree_incomplete",
    });
    expect(fake.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// import_tree: flow-wide names (spec duplicates and the name_in_use pre-check)
// ---------------------------------------------------------------------------

describe("importTree: names are unique across the whole spec and the whole flow", () => {
  const niu = (problems: Array<{ path: string }>, count = problems.length) => ({
    operation: "import_tree",
    flowId: FLOW,
    error: "name_in_use",
    count,
    problems: problems.map((p) => ({ path: p.path, reason: "name_in_use" })),
  });

  it("refuses a spec that repeats a group name under two families as spec_invalid / duplicate_name, before any platform call", async () => {
    const { fake, run } = treeRun(
      {},
      spec([
        { name: "F1", groups: [{ name: "G1", tags: ["t1"] }] },
        { name: "F2", groups: [{ name: "G1", tags: ["t2"] }] },
      ]),
      undefined,
    );
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      error: "spec_invalid",
      count: 1,
      problems: [{ path: "families[1].groups[0]", reason: "duplicate_name" }],
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [
      "a root intent with a new group's name",
      [{ id: id(1), name: "G1" }],
      "families[0].groups[0]",
    ],
    [
      "a level-2 intent under another family with a new family's name",
      [
        { id: id(1), name: "Support" },
        { id: id(2), name: "F1", parentId: id(1) },
      ],
      "families[0]",
    ],
    [
      "a level-3 intent under another family with a new tag's name",
      [
        { id: id(1), name: "Support" },
        { id: id(2), name: "Sub", parentId: id(1) },
        { id: id(3), name: "t1", parentId: id(2) },
      ],
      "families[0].groups[0].tags[0]",
    ],
  ] as Array<[string, SeedIntent[], string]>)(
    "refuses the whole call when %s exists: name_in_use at the spec path, nothing written",
    async (_label, intents, path) => {
      const { fake, run } = treeRun({ intents }, SMALL_SPEC, undefined);
      expect(await run()).toStrictEqual(niu([{ path }]));
      expect(fake.writes()).toEqual([]);
      expect(fake.listGets()).toHaveLength(1);
    },
  );

  it.each([
    ["mode add, with sentences", "add" as const],
    ["mode replace, with sentences", "replace" as const],
    ["default mode, with sentences", undefined],
  ])(
    "refuses before the first POST even when the clash is the LAST node and everything before it is new (%s)",
    async (_label, mode) => {
      // F1, G1 and t1 are all new and valid; only t2 clashes with a root intent
      const { fake, run } = treeRun(
        { intents: [{ id: id(1), name: "t2" }] },
        SMALL_SPEC,
        csv([
          ...rowsFor("t1", ["t1 sample 1"]),
          ...rowsFor("t2", ["t2 sample 1"]),
        ]),
        { mode },
      );
      expect(await run()).toStrictEqual(
        niu([{ path: "families[0].groups[0].tags[1]" }]),
      );
      expect(fake.posts()).toEqual([]);
      expect(fake.patches()).toEqual([]);
      expect(fake.writes()).toEqual([]);
    },
  );

  it("counts every clash but lists only the first 20, in spec order", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `tag-${i + 1}`);
    const { fake, run } = treeRun(
      {
        intents: names.map((name, i) => ({ id: id(i + 1), name })),
      },
      spec([{ name: "F1", groups: [{ name: "G1", tags: names }] }]),
      undefined,
    );
    expect(await run()).toStrictEqual(
      niu(
        Array.from({ length: 20 }, (_, i) => ({
          path: `families[0].groups[0].tags[${i}]`,
        })),
        25,
      ),
    );
    expect(fake.writes()).toEqual([]);
  });

  it("does not count a node that exists at its own path, only the new node that clashes elsewhere", async () => {
    // F1 and G1 exist at their own paths; G2 is new under F1 but already exists under Other
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1) },
          { id: id(3), name: "Other" },
          { id: id(4), name: "G2", parentId: id(3) },
        ],
      },
      spec([{ name: "F1", groups: [{ name: "G1" }, { name: "G2" }] }]),
      undefined,
    );
    expect(await run()).toStrictEqual(niu([{ path: "families[0].groups[1]" }]));
    expect(fake.writes()).toEqual([]);
  });

  it("a rerun of a complete import stays a no-op even when the same names also exist elsewhere (legacy duplicates)", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: true },
          { id: id(3), name: "t1", parentId: id(2) },
          { id: id(4), name: "t2", parentId: id(2) },
          // legacy duplicates of names the spec already finds at their own paths
          { id: id(5), name: "t1" },
          { id: id(6), name: "Other" },
          { id: id(7), name: "G1", parentId: id(6) },
        ],
      },
      SMALL_SPEC,
      undefined,
    );
    expect(await run()).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 1, groups: 1, tags: 2 },
        created: { families: 0, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 0,
      },
    });
    expect(fake.writes()).toEqual([]);
  });

  it("names are matched after trimming the flow's names: padded names at their own path are existing, not a clash", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1 ", childFeatures: true },
          { id: id(2), name: " G1", parentId: id(1), childFeatures: true },
          { id: id(3), name: "t1 ", parentId: id(2) },
          { id: id(4), name: "t2", parentId: id(2) },
        ],
      },
      SMALL_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.writes()).toEqual([]);
    expect(result.status).toBe("complete");
    expect(result.intents.existing).toStrictEqual({
      families: 1,
      groups: 1,
      tags: 2,
    });
  });

  it("a padded name elsewhere in the flow is a clash (trimmed compare)", async () => {
    const { fake, run } = treeRun(
      { intents: [{ id: id(1), name: "G1 " }] },
      SMALL_SPEC,
      undefined,
    );
    expect(await run()).toStrictEqual(niu([{ path: "families[0].groups[0]" }]));
    expect(fake.writes()).toEqual([]);
  });

  it("names that differ only by case are not a clash: the tree is created", async () => {
    const { fake, run } = treeRun(
      { intents: [{ id: id(1), name: "billing" }] },
      spec([{ name: "F1", groups: [{ name: "Billing" }] }]),
      undefined,
    );
    const result = await run();
    expect(fake.posts().map((c) => c.body)).toStrictEqual([
      { name: "F1", childFeatures: true },
      { name: "Billing", parentIntentId: cid(1), childFeatures: true },
    ]);
    expect(result.status).toBe("complete");
    expect(result.intents.created).toStrictEqual({
      families: 1,
      groups: 1,
      tags: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// import_tree: creation
// ---------------------------------------------------------------------------

describe("importTree: creation", () => {
  it("creates level by level in spec order with exact bodies; no sentence calls without sentencesFile", async () => {
    const { fake, run } = treeRun({}, BIG_SPEC, undefined);
    const result = await run();
    // families F1=1, F2=2 (name from `intent`), groups F1/G1=3, F1/G2=4, F2/G3=5, tags t1..t4 = 6..9
    expect(fake.posts().map((c) => [c.path, c.body])).toStrictEqual([
      [LIST_PATH, { name: "F1", childFeatures: true }],
      [LIST_PATH, { name: "F2", childFeatures: true }],
      [LIST_PATH, { name: "G1", parentIntentId: cid(1), childFeatures: true }],
      [LIST_PATH, { name: "G2", parentIntentId: cid(1), childFeatures: true }],
      [LIST_PATH, { name: "G3", parentIntentId: cid(2), childFeatures: true }],
      [LIST_PATH, { name: "t1", parentIntentId: cid(3) }],
      [LIST_PATH, { name: "t2", parentIntentId: cid(3) }],
      [LIST_PATH, { name: "t3", parentIntentId: cid(4) }],
      [LIST_PATH, { name: "t4", parentIntentId: cid(5) }],
    ]);
    expect(fake.sentenceGets()).toEqual([]);
    expect(fake.patches()).toEqual([]);
    expect(fake.listGets()).toHaveLength(1);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 2, groups: 3, tags: 4 },
        createFailed: 0,
        notAttempted: 0,
      },
    });
  });

  it("reuses existing intents (no POST for them) and creates the rest under the right existing or new parents", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: true },
        ],
      },
      BIG_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.posts().map((c) => c.body)).toStrictEqual([
      { name: "F2", childFeatures: true },
      { name: "G2", parentIntentId: id(1), childFeatures: true },
      { name: "G3", parentIntentId: cid(1), childFeatures: true },
      { name: "t1", parentIntentId: id(2) },
      { name: "t2", parentIntentId: id(2) },
      { name: "t3", parentIntentId: cid(2) },
      { name: "t4", parentIntentId: cid(3) },
    ]);
    expect(fake.patches()).toEqual([]);
    expect(fake.listGets()).toHaveLength(1);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 1, groups: 1, tags: 0 },
        created: { families: 1, groups: 2, tags: 4 },
        createFailed: 0,
        notAttempted: 0,
      },
    });
  });

  it("reports existing parents whose childFeatures is false, and does not change them", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: false },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: false },
          { id: id(3), name: "t1", parentId: id(2) },
        ],
      },
      SMALL_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.patches()).toEqual([]);
    expect(fake.writes().map((c) => c.method)).toEqual(["post"]);
    expect(fake.posts()[0].body).toStrictEqual({
      name: "t2",
      parentIntentId: id(2),
    });
    expect(result.parentsNeedingChildFeatures.count).toBe(2);
    expect(result.parentsNeedingChildFeatures.names).toHaveLength(2);
    expect(result.parentsNeedingChildFeatures.names[0]).toBe("F1");
    expect(result.intents).toStrictEqual({
      planned: { families: 1, groups: 1, tags: 2 },
      existing: { families: 1, groups: 1, tags: 1 },
      created: { families: 0, groups: 0, tags: 1 },
      createFailed: 0,
      notAttempted: 0,
    });
    expect(result.status).toBe("complete");
  });

  it("omits parentsNeedingChildFeatures when every existing parent has childFeatures true", async () => {
    const { run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: true },
          { id: id(3), name: "t1", parentId: id(2) },
        ],
      },
      SMALL_SPEC,
      undefined,
    );
    const result = await run();
    expect(result).not.toHaveProperty("parentsNeedingChildFeatures");
  });

  it("a failed family creation counts its descendants as notAttempted and creates none of them; the other family is built", async () => {
    const { fake, run } = treeRun(
      {
        postFail: (_b, n) =>
          n === 1 ? httpError(500, SENTINEL_ERR) : undefined,
      },
      BIG_SPEC,
      undefined,
    );
    const result = await run();
    // F1 fails (1); F2 (2); groups: F1/G1 and F1/G2 are not attempted, F2/G3 (3); tags: only t4 (4)
    expect(fake.posts().map((c) => c.body)).toStrictEqual([
      { name: "F1", childFeatures: true },
      { name: "F2", childFeatures: true },
      { name: "G3", parentIntentId: cid(1), childFeatures: true },
      { name: "t4", parentIntentId: cid(2) },
    ]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 1 },
        createFailed: 1,
        createFailedByStatus: { "500": 1 },
        notAttempted: 5,
      },
      names: { createFailed: ["F1"] },
      _hints: HINTS,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("a 409 on a family counts one failed create (its 5 descendants are notAttempted, not counted per status) and extends the action hint", async () => {
    const { fake, run } = treeRun(
      {
        postFail: (_b, n) =>
          n === 1 ? httpError(409, SENTINEL_ERR) : undefined,
      },
      BIG_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 1 },
        createFailed: 1,
        createFailedByStatus: { "409": 1 },
        notAttempted: 5,
      },
      names: { createFailed: ["F1"] },
      _hints: { warning: expect.stringMatching(/\S/), action: ACTION_409 },
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("counts failed tag creates per status (409 via err.response.status, 500 via err.status) and keeps the 409 hint", async () => {
    // F1=1, G1=2 ok; t1 (3) fails 409; t2 (4) fails 500
    const { fake, run } = treeRun(
      {
        postFail: (_b, n) =>
          n === 3
            ? httpError(409, SENTINEL_ERR)
            : n === 4
              ? statusError(500, SENTINEL_ERR)
              : undefined,
      },
      SMALL_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 0 },
        createFailed: 2,
        createFailedByStatus: { "409": 1, "500": 1 },
        notAttempted: 0,
      },
      names: { createFailed: ["t1", "t2"] },
      _hints: { warning: expect.stringMatching(/\S/), action: ACTION_409 },
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ERR);
  });

  it("a failed group creation (response without _id) makes only its tags notAttempted", async () => {
    // order: F1=1, F2=2, F1/G1=3, F1/G2=4, F2/G3=5 (fails), t1=6, t2=7, t3=8
    const { fake, run } = treeRun(
      { postFail: (_b, n) => (n === 5 ? "noid" : undefined) },
      BIG_SPEC,
      undefined,
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(8);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 2, groups: 2, tags: 3 },
        createFailed: 1,
        createFailedByStatus: { none: 1 },
        notAttempted: 1,
      },
      names: { createFailed: ["G3"] },
      _hints: HINTS,
    });
  });

  it("the deadline turns every remaining planned intent into notAttempted", async () => {
    let t = 0;
    const { fake, run } = treeRun(
      {
        onPost: () => {
          t = 1000;
        },
      },
      BIG_SPEC,
      undefined,
      { deadlineSeconds: 1, now: () => t },
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(1);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 8,
      },
      _hints: HINTS,
    });
  });
});

// ---------------------------------------------------------------------------
// import_tree: sentences
// ---------------------------------------------------------------------------

describe("importTree: sentences", () => {
  it("matches rows to tags by name, counts rows for non-tag names as notInSpec, and never gives parents sentences", async () => {
    const { fake, run } = treeRun(
      {},
      SMALL_SPEC,
      csv([
        ...rowsFor("t1", ["t1 sample 1", "t1 sample 2", "t1 sample 3"]),
        ...rowsFor("Stray", ["s sample 1", "s sample 2", "s sample 3"]),
        ...rowsFor("t2", ["t2 sample 1", "t2 sample 2"]),
        ...rowsFor("Stray2", ["s2 sample 1"]),
        ...rowsFor("G1", ["group sample 1"]),
      ]),
    );
    const result = await run();
    // F1=1, G1=2, t1=3, t2=4
    expect(fake.patches().map((c) => c.path)).toEqual([
      SENT_PATH(cid(3)),
      SENT_PATH(cid(4)),
    ]);
    const touched = new Set(fake.sentenceGets().map((c) => c.path));
    expect(touched).toEqual(new Set([SENT_PATH(cid(3)), SENT_PATH(cid(4))]));
    expect(fake.posts()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 2 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 10,
        created: 5,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 2,
      skipped: { notInSpecRows: 5, notInSpecIntents: 3 },
      names: { notInSpec: ["Stray", "Stray2", "G1"] },
    });
    expect(fake.texts(cid(3))).toEqual([
      "t1 sample 1",
      "t1 sample 2",
      "t1 sample 3",
    ]);
  });

  it("counts rows of tags whose creation failed or was not attempted under skipped.tagNotCreated", async () => {
    const { fake, run } = treeRun(
      {
        postFail: (_b, n) =>
          n === 1 ? httpError(500, SENTINEL_ERR) : undefined,
      },
      BIG_SPEC,
      csv([
        ...rowsFor("t1", [`${SENTINEL_SENTENCE} 1`, `${SENTINEL_SENTENCE} 2`]),
        ...rowsFor("t3", [`${SENTINEL_SENTENCE} 3`]),
        ...rowsFor("t4", ["t4 sample 1", "t4 sample 2", "t4 sample 3"]),
      ]),
    );
    const result = await run();
    // F1's POST is rejected (no id). Successful creations are numbered: F2=cid(1), F2/G1=cid(2), t4=cid(3)
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(cid(3))]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "partial",
      intents: {
        planned: { families: 2, groups: 3, tags: 4 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 1 },
        createFailed: 1,
        createFailedByStatus: { "500": 1 },
        notAttempted: 5,
      },
      sentences: {
        rows: 6,
        created: 3,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      skipped: { tagNotCreated: 3 },
      names: { createFailed: ["F1"] },
      _hints: HINTS,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });

  it("skips an over-cap tag but still creates it, and imports the others", async () => {
    const { fake, run } = treeRun(
      {},
      SMALL_SPEC,
      csv([
        ...rowsFor("t1", gen("big", 201)),
        ...rowsFor("t2", ["t2 sample 1", "t2 sample 2"]),
      ]),
    );
    const result = await run();
    // F1=1, G1=2, t1=3, t2=4
    expect(fake.posts()).toHaveLength(4);
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(cid(4))]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 2 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 203,
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      skipped: { overCap: 1 },
      names: { overCap: ["t1"] },
    });
  });

  it("skips an existing tag that would end above 200 and retries once with the rest", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: true },
          {
            id: id(3),
            name: "t1",
            parentId: id(2),
            sentences: gen("old", 195),
          },
          { id: id(4), name: "t2", parentId: id(2) },
        ],
      },
      SMALL_SPEC,
      csv([
        ...rowsFor("t1", gen("new", 10)),
        ...rowsFor("t2", ["t2 sample 1", "t2 sample 2"]),
      ]),
    );
    const result = await run();
    // t1 (195 existing) is one full read = 2 page requests, not re-read by the retry;
    // t2 (0 existing) has one full read in each of the two passes.
    const gets = (p: string) => fake.sentenceGets().filter((c) => c.path === p);
    const fullReads = (p: string) =>
      gets(p).filter((c) => c.params?.next === undefined).length;
    expect(fullReads(SENT_PATH(id(3)))).toBe(1);
    expect(gets(SENT_PATH(id(3)))).toHaveLength(2);
    expect(fullReads(SENT_PATH(id(4)))).toBe(2);
    expect(gets(SENT_PATH(id(4)))).toHaveLength(2);
    expect(fake.patches().map((c) => c.path)).toEqual([SENT_PATH(id(4))]);
    expect(fake.posts()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 1, groups: 1, tags: 2 },
        created: { families: 0, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 12,
        created: 2,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 1,
      skipped: { capExceeded: 1 },
      names: { capExceeded: ["t1"] },
    });
  });

  it("passes mode replace through", async () => {
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "F1", childFeatures: true },
          { id: id(2), name: "G1", parentId: id(1), childFeatures: true },
          {
            id: id(3),
            name: "t1",
            parentId: id(2),
            sentences: ["old one", "keep one"],
          },
        ],
      },
      spec([{ name: "F1", groups: [{ name: "G1", tags: ["t1"] }] }]),
      csv(rowsFor("t1", ["keep one", "new one"])),
      { mode: "replace" },
    );
    const result = await run();
    expect(fake.ops(fake.patches()[0])).toEqual([
      { op: "delete", id: `${id(3)}-s0` },
      create("new one"),
    ]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "replace",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 1 },
        existing: { families: 1, groups: 1, tags: 1 },
        created: { families: 0, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 2,
        created: 1,
        deleted: 1,
        skippedExisting: 1,
        duplicatesDropped: 0,
      },
      batches: 1,
    });
  });

  it("reports a failed sentence import as partial with notDone.failed and names.failed", async () => {
    const { run } = treeRun(
      {
        failPatch: (intentId) =>
          intentId === cid(4) ? httpError(500, SENTINEL_ERR) : undefined,
      },
      SMALL_SPEC,
      csv([
        ...rowsFor("t1", ["t1 sample 1"]),
        ...rowsFor("t2", [`${SENTINEL_SENTENCE} 2`]),
      ]),
    );
    const result = await run();
    expect(result.status).toBe("partial");
    expect(result.notDone).toStrictEqual({ failed: 1 });
    expect(result.names).toStrictEqual({ failed: ["t2"] });
    expect(result.batches).toBe(1);
    expect(result._hints).toStrictEqual(HINTS);
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });

  it("a rerun after a complete run makes no POST and no PATCH, reads the tree once per call, and reports everything as existing", async () => {
    const cfg: FakeCfg = {};
    const text = csv([
      ...rowsFor("t1", ["t1 sample 1", "t1 sample 2", "t1 sample 3"]),
      ...rowsFor("t2", ["t2 sample 1", "t2 sample 2"]),
    ]);
    const { fake, run } = treeRun(cfg, SMALL_SPEC, text);
    const first = await run();
    expect(first.status).toBe("complete");
    expect(fake.listGets()).toHaveLength(1);
    expect(fake.posts()).toHaveLength(4);
    expect(fake.patches()).toHaveLength(2);
    const second = await run();
    expect(fake.listGets()).toHaveLength(2);
    expect(fake.posts()).toHaveLength(4);
    expect(fake.patches()).toHaveLength(2);
    expect(second).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 1, groups: 1, tags: 2 },
        created: { families: 0, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 5,
        created: 0,
        deleted: 0,
        skippedExisting: 5,
        duplicatesDropped: 0,
      },
      batches: 0,
    });
  });

  it("a rerun after a partial run creates what is missing and finishes the sentences", async () => {
    const cfg: FakeCfg = {
      postFail: (_b, n) => (n === 4 ? httpError(500, SENTINEL_ERR) : undefined),
    };
    // F1=1, G1=2, t1=3, t2 fails (4)
    const text = csv([
      ...rowsFor("t1", ["t1 sample 1"]),
      ...rowsFor("t2", ["t2 sample 1"]),
    ]);
    const { fake, run } = treeRun(cfg, SMALL_SPEC, text);
    const first = await run();
    expect(first.status).toBe("partial");
    expect(first.intents.createFailed).toBe(1);
    cfg.postFail = undefined;
    const second = await run();
    expect(second).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 1, groups: 1, tags: 1 },
        created: { families: 0, groups: 0, tags: 1 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 2,
        created: 1,
        deleted: 0,
        skippedExisting: 1,
        duplicatesDropped: 0,
      },
      batches: 1,
    });
    expect(fake.posts()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Mutation-check additions
// ---------------------------------------------------------------------------

describe("cap boundary counts distinct sentences after trimming", () => {
  const paddedRows = (intent: string): Array<[string, string]> =>
    // 201 rows, 200 distinct after trimming
    rowsFor(intent, [...gen("pad", 199), "dup sample", "  dup sample "]);

  it("import_csv: 201 rows with two differing only by whitespace are imported (200 distinct), duplicatesDropped 1", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv(paddedRows("Alpha")),
    );
    const result = await run();
    expect(fake.patches()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_csv",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: { inFile: 1, existing: 1, created: 0, createFailed: 0 },
      sentences: {
        rows: 201,
        created: 200,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 1,
      },
      batches: 4,
    });
  });

  it("import_csv: 201 truly distinct sentences are skipped as overCap", async () => {
    const { fake, run } = csvRun(
      { intents: [{ id: ALPHA, name: "Alpha" }] },
      csv(rowsFor("Alpha", gen("real", 201))),
    );
    const result = await run();
    expect(fake.patches()).toEqual([]);
    expect(result.skipped).toStrictEqual({ overCap: 1 });
    expect(result.names).toStrictEqual({ overCap: ["Alpha"] });
    expect(result.sentences).toStrictEqual(zeroSentences(201));
  });

  it("import_tree: 201 rows with two differing only by whitespace are imported (200 distinct), duplicatesDropped 1", async () => {
    const { fake, run } = treeRun({}, SMALL_SPEC, csv(paddedRows("t1")));
    const result = await run();
    expect(fake.patches()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 1, groups: 1, tags: 2 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 1, groups: 1, tags: 2 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 201,
        created: 200,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 1,
      },
      batches: 4,
    });
  });
});

describe("importTree: tag cap boundary", () => {
  const ONE_TAG = spec([
    { name: "F1", groups: [{ name: "G1", tags: ["t1"] }] },
  ]);
  const planned = {
    planned: { families: 1, groups: 1, tags: 1 },
    existing: { families: 0, groups: 0, tags: 0 },
    created: { families: 1, groups: 1, tags: 1 },
    createFailed: 0,
    notAttempted: 0,
  };

  it("imports a tag with exactly 200 distinct sentences", async () => {
    const { fake, run } = treeRun(
      {},
      ONE_TAG,
      csv(rowsFor("t1", gen("x", 200))),
    );
    const result = await run();
    expect(fake.patches()).toHaveLength(4);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: planned,
      sentences: {
        rows: 200,
        created: 200,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 4,
    });
  });

  it("skips a tag with 201 distinct sentences as overCap but still creates it", async () => {
    const { fake, run } = treeRun(
      {},
      ONE_TAG,
      csv(rowsFor("t1", gen("x", 201))),
    );
    const result = await run();
    expect(fake.posts()).toHaveLength(3);
    expect(fake.patches()).toEqual([]);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: planned,
      sentences: zeroSentences(201),
      batches: 0,
      skipped: { overCap: 1 },
      names: { overCap: ["t1"] },
    });
  });
});

describe("a creation POST that resolves with a non-object", () => {
  const kinds: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "created"],
    ["a number", 42],
  ];

  it.each(kinds)(
    "import_csv: %s is createFailed, no sentence call for it, partial",
    async (_l, response) => {
      const { fake, run } = csvRun(
        {
          intents: [{ id: ALPHA, name: "Alpha" }],
          postFail: (_b, n) => (n === 1 ? { response } : undefined),
        },
        csv([
          ["Bad", "b sample 1"],
          ["Alpha", "a sample 1"],
        ]),
      );
      const result = await run();
      expect(fake.sentenceGets().map((c) => c.path)).toEqual([
        SENT_PATH(ALPHA),
      ]);
      expect(result).toStrictEqual({
        operation: "import_csv",
        flowId: FLOW,
        ok: true,
        mode: "add",
        status: "partial",
        intents: {
          inFile: 2,
          existing: 1,
          created: 0,
          createFailed: 1,
          createFailedByStatus: { none: 1 },
        },
        sentences: {
          rows: 2,
          created: 1,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
        },
        batches: 1,
        names: { createFailed: ["Bad"] },
        _hints: HINTS,
      });
    },
  );

  it.each(kinds)(
    "import_tree: %s for a group makes the group createFailed and its tags notAttempted",
    async (_l, response) => {
      // F1=1 ok, G1=2 fails
      const { fake, run } = treeRun(
        { postFail: (_b, n) => (n === 2 ? { response } : undefined) },
        SMALL_SPEC,
        csv(rowsFor("t1", ["t1 sample 1", "t1 sample 2"])),
      );
      const result = await run();
      expect(fake.posts()).toHaveLength(2);
      expect(fake.sentenceGets()).toEqual([]);
      expect(result).toStrictEqual({
        operation: "import_tree",
        flowId: FLOW,
        ok: true,
        mode: "add",
        status: "partial",
        intents: {
          planned: { families: 1, groups: 1, tags: 2 },
          existing: { families: 0, groups: 0, tags: 0 },
          created: { families: 1, groups: 0, tags: 0 },
          createFailed: 1,
          createFailedByStatus: { none: 1 },
          notAttempted: 2,
        },
        sentences: zeroSentences(2),
        batches: 0,
        skipped: { tagNotCreated: 2 },
        names: { createFailed: ["G1"] },
        _hints: HINTS,
      });
    },
  );

  it.each(kinds)(
    "import_tree: %s for a tag makes that tag createFailed, no sentence call for it, the other tag imported",
    async (_l, response) => {
      // F1=1, G1=2, t1=3 fails, t2 = cid(3)
      const { fake, run } = treeRun(
        { postFail: (_b, n) => (n === 3 ? { response } : undefined) },
        SMALL_SPEC,
        csv([
          ...rowsFor("t1", ["t1 sample 1"]),
          ...rowsFor("t2", ["t2 sample 1", "t2 sample 2"]),
        ]),
      );
      const result = await run();
      expect(fake.sentenceGets().map((c) => c.path)).toEqual([
        SENT_PATH(cid(3)),
      ]);
      expect(result).toStrictEqual({
        operation: "import_tree",
        flowId: FLOW,
        ok: true,
        mode: "add",
        status: "partial",
        intents: {
          planned: { families: 1, groups: 1, tags: 2 },
          existing: { families: 0, groups: 0, tags: 0 },
          created: { families: 1, groups: 1, tags: 1 },
          createFailed: 1,
          createFailedByStatus: { none: 1 },
          notAttempted: 0,
        },
        sentences: {
          rows: 3,
          created: 2,
          deleted: 0,
          skippedExisting: 0,
          duplicatesDropped: 0,
        },
        batches: 1,
        skipped: { tagNotCreated: 1 },
        names: { createFailed: ["t1"] },
        _hints: HINTS,
      });
    },
  );
});

describe("importTree: parentsNeedingChildFeatures with all three kinds at once", () => {
  it("reports only existing parents WITH children and childFeatures false", async () => {
    // FA(false, has child) -> GA(false, has child) -> TA       : both reported
    // FB(true,  has child) -> GB(true, has child) -> TB        : neither reported
    // FB -> GD(false, leaf: no children, reader reports no childFeatures) : not reported
    // FC(false, leaf family)                                    : not reported
    const { fake, run } = treeRun(
      {
        intents: [
          { id: id(1), name: "FA", childFeatures: false },
          { id: id(2), name: "GA", parentId: id(1), childFeatures: false },
          { id: id(3), name: "TA", parentId: id(2) },
          { id: id(4), name: "FB", childFeatures: true },
          { id: id(5), name: "GB", parentId: id(4), childFeatures: true },
          { id: id(6), name: "TB", parentId: id(5) },
          { id: id(7), name: "GD", parentId: id(4), childFeatures: false },
          { id: id(8), name: "FC", childFeatures: false },
        ],
      },
      spec([
        { name: "FA", groups: [{ name: "GA", tags: ["TA"] }] },
        {
          name: "FB",
          groups: [
            { name: "GB", tags: ["TB"] },
            { name: "GD", tags: [] },
          ],
        },
        { name: "FC" },
      ]),
      undefined,
    );
    const result = await run();
    expect(fake.writes()).toEqual([]);
    expect(
      fake
        .oneGets()
        .map((c) => c.path)
        .sort(),
    ).toEqual([id(1), id(2), id(4), id(5)].map(ONE_PATH).sort());
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 3, groups: 3, tags: 2 },
        existing: { families: 3, groups: 3, tags: 2 },
        created: { families: 0, groups: 0, tags: 0 },
        createFailed: 0,
        notAttempted: 0,
      },
      parentsNeedingChildFeatures: { count: 2, names: ["FA", "GA"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

describe("importTree: scale (11 families, 87 groups, 367 tags, 7,197 rows)", () => {
  it("makes one tree read, 465 POSTs, and the hand-computed sentence calls; no result string holds sentence text", async () => {
    // Groups per family: the first 10 families have 8 groups, the last has 7 (10*8 + 7 = 87).
    // Tags per group: the first 19 groups have 5 tags, the other 68 have 4 (19*5 + 68*4 = 367).
    // Every name is unique across the whole spec (fam-N, grp-1..grp-87, tag-1..tag-367).
    const families: any[] = [];
    let groupSeq = 0;
    let tagSeq = 0;
    for (let f = 1; f <= 11; f++) {
      const groupCount = f <= 10 ? 8 : 7;
      const groups: any[] = [];
      for (let g = 1; g <= groupCount; g++) {
        groupSeq++;
        const tagCount = groupSeq <= 19 ? 5 : 4;
        const tags: string[] = [];
        for (let k = 0; k < tagCount; k++) tags.push(`tag-${++tagSeq}`);
        groups.push({ name: `grp-${groupSeq}`, tags });
      }
      families.push({ name: `fam-${f}`, groups });
    }
    expect(groupSeq).toBe(87);
    expect(tagSeq).toBe(367);

    // Rows: tag-1 gets 201 distinct sentences (over the cap, skipped).
    // Remaining 7197 - 201 = 6996 rows over tags 2..367 (366 tags): 366*19 = 6954, 42 left over,
    // so tags 2..43 (42 tags) get 20 rows and tags 44..367 (324 tags) get 19: 42*20 + 324*19 = 840 + 6156 = 6996.
    // Every imported tag has at most 20 sentences, so it takes exactly 1 PATCH (<= 50 operations):
    // 366 PATCH calls, 366 existing-sentence GETs, created sentences = 6996, rows = 7197.
    const rows: Array<[string, string]> = [];
    for (let n = 1; n <= 367; n++) {
      const count = n === 1 ? 201 : n <= 43 ? 20 : 19;
      for (let i = 1; i <= count; i++) {
        rows.push([`tag-${n}`, `SCALE_SENTENCE_${n}_${i}`]);
      }
    }
    expect(rows).toHaveLength(7197);

    const { fake, run } = treeRun({}, spec(families), csv(rows));
    const result = await run();

    expect(fake.listGets()).toHaveLength(1);
    expect(fake.posts()).toHaveLength(465);
    expect(fake.patches()).toHaveLength(366);
    expect(fake.sentenceGets()).toHaveLength(366);
    expect(fake.oneGets()).toEqual([]);
    expect(
      fake.patches().every((c) => (c.body.operations as any[]).length <= 20),
    ).toBe(true);
    expect(
      fake
        .patches()
        .some((c) => c.path === SENT_PATH(cid(1 + 11 + 87 + 1 - 1))),
    ).toBe(false);
    expect(result).toStrictEqual({
      operation: "import_tree",
      flowId: FLOW,
      ok: true,
      mode: "add",
      status: "complete",
      intents: {
        planned: { families: 11, groups: 87, tags: 367 },
        existing: { families: 0, groups: 0, tags: 0 },
        created: { families: 11, groups: 87, tags: 367 },
        createFailed: 0,
        notAttempted: 0,
      },
      sentences: {
        rows: 7197,
        created: 6996,
        deleted: 0,
        skippedExisting: 0,
        duplicatesDropped: 0,
      },
      batches: 366,
      skipped: { overCap: 1 },
      names: { overCap: ["tag-1"] },
    });
    expect(JSON.stringify(result)).not.toContain("SCALE_SENTENCE_");
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("import_csv: sentinel sentences and upstream error text never appear in any result", async () => {
    const { run } = csvRun(
      {
        intents: [{ id: ALPHA, name: "Alpha" }],
        postFail: () => httpError(500, `${SENTINEL_ERR} ${SENTINEL_SENTENCE}`),
        failPatch: () => httpError(500, `${SENTINEL_ERR} ${SENTINEL_SENTENCE}`),
      },
      csv([
        ...rowsFor("Alpha", [`${SENTINEL_SENTENCE} 1`]),
        ...rowsFor("Newone", [`${SENTINEL_SENTENCE} 2`]),
        ...rowsFor("Huge", gen(SENTINEL_SENTENCE, 201)),
      ]),
    );
    const json = JSON.stringify(await run());
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });

  it("import_tree: sentinel sentences and upstream error text never appear in any result", async () => {
    const { run } = treeRun(
      {
        postFail: (_b, n) =>
          n === 4
            ? httpError(500, `${SENTINEL_ERR} ${SENTINEL_SENTENCE}`)
            : undefined,
        failPatch: () => httpError(500, `${SENTINEL_ERR} ${SENTINEL_SENTENCE}`),
      },
      SMALL_SPEC,
      csv([
        ...rowsFor("t1", [`${SENTINEL_SENTENCE} 1`]),
        ...rowsFor("t2", [`${SENTINEL_SENTENCE} 2`]),
        ...rowsFor("Stray", [`${SENTINEL_SENTENCE} 3`]),
      ]),
    );
    const json = JSON.stringify(await run());
    expect(json).not.toContain(SENTINEL_ERR);
    expect(json).not.toContain(SENTINEL_SENTENCE);
  });
});
