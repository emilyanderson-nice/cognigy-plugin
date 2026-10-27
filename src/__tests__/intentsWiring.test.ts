import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { manageIntentsSchema } from "../schemas/tools.js";
import { tools } from "../tools/definitions.js";
import { ToolHandlers } from "../tools/handlers.js";
import { logger } from "../utils/logger.js";

// Synthetic ids only.
const FLOW = "ffffffffffffffffffffff01";
const PROJECT = "eeeeeeeeeeeeeeeeeeeeee01";
const PROJECT_B = "eeeeeeeeeeeeeeeeeeeeee02";
const INTENT_ID = "aaaaaaaaaaaaaaaaaaaa0001";

const OPERATIONS = [
  "list",
  "get",
  "export_tree",
  "below_minimum",
  "compare",
  "model_state",
  "create",
  "update",
  "move",
  "delete",
  "import_sentences",
  "build",
  "import_csv",
  "import_tree",
] as const;

const WRITE_OPERATIONS = [
  "create",
  "update",
  "move",
  "delete",
  "import_sentences",
  "build",
  "import_csv",
  "import_tree",
] as const;
const READ_OPERATIONS = [
  "list",
  "get",
  "export_tree",
  "below_minimum",
  "compare",
  "model_state",
] as const;

/** One valid minimal payload per operation. */
const VALID: Record<string, Record<string, unknown>> = {
  list: { operation: "list", flowId: FLOW },
  get: { operation: "get", flowId: FLOW, intent: "Billing question" },
  export_tree: { operation: "export_tree", flowId: FLOW },
  below_minimum: { operation: "below_minimum", flowId: FLOW },
  compare: { operation: "compare", flowId: FLOW, file: "intents.csv" },
  model_state: { operation: "model_state", flowId: FLOW },
  create: {
    operation: "create",
    flowId: FLOW,
    projectId: PROJECT,
    name: "Billing question",
  },
  update: {
    operation: "update",
    flowId: FLOW,
    projectId: PROJECT,
    intent: "Billing question",
    name: "Billing questions",
  },
  move: {
    operation: "move",
    flowId: FLOW,
    projectId: PROJECT,
    intent: "Billing question",
    parent: "Billing",
  },
  delete: {
    operation: "delete",
    flowId: FLOW,
    projectId: PROJECT,
    intent: "Billing question",
  },
  import_sentences: {
    operation: "import_sentences",
    flowId: FLOW,
    projectId: PROJECT,
    mode: "add",
    entries: [{ intent: "Billing question", sentences: ["where is my bill"] }],
  },
  build: { operation: "build", flowId: FLOW, projectId: PROJECT },
  import_csv: {
    operation: "import_csv",
    flowId: FLOW,
    projectId: PROJECT,
    file: "sentences.csv",
    mode: "add",
  },
  import_tree: {
    operation: "import_tree",
    flowId: FLOW,
    projectId: PROJECT,
    specFile: "tree.csv",
  },
};

const parses = (payload: unknown): boolean =>
  manageIntentsSchema.safeParse(payload).success;
const withFields = (
  op: string,
  extra: Record<string, unknown>,
  drop: string[] = [],
): Record<string, unknown> => {
  const copy = { ...VALID[op], ...extra };
  for (const k of drop) delete copy[k];
  return copy;
};
const strings = (n: number, len = 1): string[] =>
  Array.from({ length: n }, () => "s".repeat(len));

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("manageIntentsSchema", () => {
  it("covers every operation of the contract in the fixtures", () => {
    expect(Object.keys(VALID)).toEqual([...OPERATIONS]);
  });

  it.each(OPERATIONS)(
    "parses a minimal %s payload and keeps its fields",
    (op) => {
      const parsed = manageIntentsSchema.parse(VALID[op]);
      expect(parsed).toEqual(VALID[op]);
    },
  );

  it.each(OPERATIONS)("rejects %s with a flowId that is not 24-hex", (op) => {
    expect(parses(withFields(op, { flowId: "not-a-flow-id" }))).toBe(false);
    expect(parses(withFields(op, { flowId: "FFFFFFFFFFFFFFFFFFFFFF01" }))).toBe(
      false,
    );
    expect(parses(withFields(op, { flowId: FLOW.slice(1) }))).toBe(false);
    expect(parses(withFields(op, {}, ["flowId"]))).toBe(false);
  });

  it.each(WRITE_OPERATIONS)("requires projectId on %s", (op) => {
    expect(parses(VALID[op])).toBe(true);
    expect(parses(withFields(op, {}, ["projectId"]))).toBe(false);
    expect(parses(withFields(op, { projectId: "nope" }))).toBe(false);
  });

  it.each(READ_OPERATIONS)("does not require projectId on %s", (op) => {
    expect(VALID[op].projectId).toBeUndefined();
    expect(parses(VALID[op])).toBe(true);
  });

  it("rejects an unknown or missing operation", () => {
    expect(parses({ operation: "frobnicate", flowId: FLOW })).toBe(false);
    expect(parses({ flowId: FLOW })).toBe(false);
  });

  it("list accepts the optional booleans and rejects non-booleans", () => {
    const p = {
      ...VALID.list,
      includeSentenceCounts: false,
      includeStatus: true,
    };
    expect(manageIntentsSchema.parse(p)).toEqual(p);
    expect(parses({ ...VALID.list, includeStatus: "yes" })).toBe(false);
  });

  it("get takes includeSentences and bounds intent to 1-300 chars", () => {
    const p = { ...VALID.get, includeSentences: true };
    expect(manageIntentsSchema.parse(p)).toEqual(p);
    expect(parses(withFields("get", { intent: "" }))).toBe(false);
    expect(parses(withFields("get", { intent: "x".repeat(300) }))).toBe(true);
    expect(parses(withFields("get", { intent: "x".repeat(301) }))).toBe(false);
    expect(parses(withFields("get", {}, ["intent"]))).toBe(false);
  });

  it.each(["delete", "update", "move"])(
    "%s bounds intent to 1-300 chars",
    (op) => {
      expect(parses(withFields(op, { intent: "" }))).toBe(false);
      expect(parses(withFields(op, { intent: "x".repeat(300) }))).toBe(true);
      expect(parses(withFields(op, { intent: "x".repeat(301) }))).toBe(false);
      expect(parses(withFields(op, {}, ["intent"]))).toBe(false);
    },
  );

  it("below_minimum: min is an integer from 1 to 200", () => {
    for (const min of [1, 5, 200]) {
      expect(parses(withFields("below_minimum", { min }))).toBe(true);
    }
    for (const min of [0, 201, -1, 1.5, "5"]) {
      expect(parses(withFields("below_minimum", { min }))).toBe(false);
    }
  });

  it("compare: file is 1-500 chars and required", () => {
    expect(parses(withFields("compare", { file: "" }))).toBe(false);
    expect(parses(withFields("compare", { file: "f".repeat(500) }))).toBe(true);
    expect(parses(withFields("compare", { file: "f".repeat(501) }))).toBe(
      false,
    );
    expect(parses(withFields("compare", {}, ["file"]))).toBe(false);
  });

  it("create: name is 1-200 chars and required", () => {
    expect(parses(withFields("create", { name: "" }))).toBe(false);
    expect(parses(withFields("create", { name: "n".repeat(200) }))).toBe(true);
    expect(parses(withFields("create", { name: "n".repeat(201) }))).toBe(false);
    expect(parses(withFields("create", {}, ["name"]))).toBe(false);
  });

  it("create: parent 1-300, childFeatures boolean, priority parents|children", () => {
    const full = {
      ...VALID.create,
      parent: "Billing",
      childFeatures: true,
      priority: "children",
      sentences: ["one", "two"],
    };
    expect(manageIntentsSchema.parse(full)).toEqual(full);
    expect(parses(withFields("create", { parent: "" }))).toBe(false);
    expect(parses(withFields("create", { parent: "p".repeat(300) }))).toBe(
      true,
    );
    expect(parses(withFields("create", { parent: "p".repeat(301) }))).toBe(
      false,
    );
    expect(parses(withFields("create", { childFeatures: "true" }))).toBe(false);
    expect(parses(withFields("create", { priority: "parents" }))).toBe(true);
    expect(parses(withFields("create", { priority: "children" }))).toBe(true);
    expect(parses(withFields("create", { priority: "both" }))).toBe(false);
    expect(parses(withFields("create", { priority: "" }))).toBe(false);
  });

  it("update: needs at least one of name, childFeatures, priority", () => {
    expect(parses(withFields("update", {}, ["name"]))).toBe(false);
    expect(parses(withFields("update", { name: "New name" }))).toBe(true);
    expect(
      parses(withFields("update", { childFeatures: false }, ["name"])),
    ).toBe(true);
    expect(
      parses(withFields("update", { priority: "parents" }, ["name"])),
    ).toBe(true);
    expect(
      parses(withFields("update", { priority: "children" }, ["name"])),
    ).toBe(true);
    expect(parses(withFields("update", { name: "" }))).toBe(false);
    expect(parses(withFields("update", { name: "n".repeat(200) }))).toBe(true);
    expect(parses(withFields("update", { name: "n".repeat(201) }))).toBe(false);
    expect(
      parses(withFields("update", { priority: "sideways" }, ["name"])),
    ).toBe(false);
  });

  it("move: parent must be present, a 1-300 string or null", () => {
    expect(parses(withFields("move", {}, ["parent"]))).toBe(false);
    expect(parses(withFields("move", { parent: null }))).toBe(true);
    expect(
      manageIntentsSchema.parse(withFields("move", { parent: null })),
    ).toEqual(withFields("move", { parent: null }));
    expect(parses(withFields("move", { parent: "Billing" }))).toBe(true);
    expect(parses(withFields("move", { parent: "" }))).toBe(false);
    expect(parses(withFields("move", { parent: "p".repeat(300) }))).toBe(true);
    expect(parses(withFields("move", { parent: "p".repeat(301) }))).toBe(false);
    expect(parses(withFields("move", { parent: 5 }))).toBe(false);
  });

  it("import_sentences: mode is required and only add or replace", () => {
    expect(parses(withFields("import_sentences", {}, ["mode"]))).toBe(false);
    expect(parses(withFields("import_sentences", { mode: "add" }))).toBe(true);
    expect(parses(withFields("import_sentences", { mode: "replace" }))).toBe(
      true,
    );
    expect(parses(withFields("import_sentences", { mode: "merge" }))).toBe(
      false,
    );
  });

  it("build: mode is optional and only full or quick", () => {
    expect(parses(VALID.build)).toBe(true);
    expect(parses(withFields("build", { mode: "full" }))).toBe(true);
    expect(parses(withFields("build", { mode: "quick" }))).toBe(true);
    expect(parses(withFields("build", { mode: "fast" }))).toBe(false);
  });

  it("build: waitSeconds is an integer from 0 to 300", () => {
    for (const waitSeconds of [0, 1, 60, 300]) {
      expect(parses(withFields("build", { waitSeconds }))).toBe(true);
    }
    for (const waitSeconds of [301, -1, 1.5, "10"]) {
      expect(parses(withFields("build", { waitSeconds }))).toBe(false);
    }
  });

  it("create: sentences are at most 200 items of 1-500 chars", () => {
    expect(parses(withFields("create", { sentences: strings(200) }))).toBe(
      true,
    );
    expect(parses(withFields("create", { sentences: strings(201) }))).toBe(
      false,
    );
    expect(parses(withFields("create", { sentences: strings(1, 500) }))).toBe(
      true,
    );
    expect(parses(withFields("create", { sentences: strings(1, 501) }))).toBe(
      false,
    );
    expect(parses(withFields("create", { sentences: [""] }))).toBe(false);
  });

  it("import_sentences: entries are 1-500 items", () => {
    const entry = { intent: "Billing", sentences: ["a"] };
    const entries = (n: number) => Array.from({ length: n }, () => entry);
    expect(parses(withFields("import_sentences", { entries: [] }))).toBe(false);
    expect(
      parses(withFields("import_sentences", { entries: entries(1) })),
    ).toBe(true);
    expect(
      parses(withFields("import_sentences", { entries: entries(500) })),
    ).toBe(true);
    expect(
      parses(withFields("import_sentences", { entries: entries(501) })),
    ).toBe(false);
    expect(parses(withFields("import_sentences", {}, ["entries"]))).toBe(false);
  });

  it("import_sentences: each entry has a 1-300 char intent and 1-500 char sentences, at most 200 per entry", () => {
    const one = (entry: unknown) =>
      parses(withFields("import_sentences", { entries: [entry] }));
    expect(one({ intent: "", sentences: ["a"] })).toBe(false);
    expect(one({ intent: "x".repeat(300), sentences: ["a"] })).toBe(true);
    expect(one({ intent: "x".repeat(301), sentences: ["a"] })).toBe(false);
    expect(one({ intent: "Billing", sentences: strings(200) })).toBe(true);
    expect(one({ intent: "Billing", sentences: strings(201) })).toBe(false);
    expect(one({ intent: "Billing", sentences: strings(1, 500) })).toBe(true);
    expect(one({ intent: "Billing", sentences: strings(1, 501) })).toBe(false);
    expect(one({ intent: "Billing", sentences: [""] })).toBe(false);
    expect(one({ sentences: ["a"] })).toBe(false);
    expect(one({ intent: "Billing" })).toBe(false);
  });

  it("import_sentences: at most 10000 sentences in total across entries", () => {
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        intent: `Intent ${i}`,
        sentences: strings(200),
      }));
    expect(
      parses(withFields("import_sentences", { entries: entries(50) })),
    ).toBe(true);
    expect(
      parses(withFields("import_sentences", { entries: entries(51) })),
    ).toBe(false);
    // 49 full entries plus one with 199 is 9999 in total; with 201 it would
    // already fail per entry, so 200 + 1 extra entry of 1 is the 10001 edge.
    const edge = [...entries(50), { intent: "One more", sentences: ["a"] }];
    expect(parses(withFields("import_sentences", { entries: edge }))).toBe(
      false,
    );
  });

  it("import_csv: file is 1-500 chars, mode is required add|replace", () => {
    expect(parses(withFields("import_csv", { file: "" }))).toBe(false);
    expect(parses(withFields("import_csv", { file: "f".repeat(500) }))).toBe(
      true,
    );
    expect(parses(withFields("import_csv", { file: "f".repeat(501) }))).toBe(
      false,
    );
    expect(parses(withFields("import_csv", {}, ["file"]))).toBe(false);
    expect(parses(withFields("import_csv", {}, ["mode"]))).toBe(false);
    expect(parses(withFields("import_csv", { mode: "replace" }))).toBe(true);
    expect(parses(withFields("import_csv", { mode: "merge" }))).toBe(false);
    expect(parses(withFields("import_csv", {}, ["projectId"]))).toBe(false);
    expect(parses(withFields("import_csv", { flowId: "bad" }))).toBe(false);
  });

  it("import_csv: createMissing is an optional boolean", () => {
    for (const createMissing of [true, false]) {
      const p = withFields("import_csv", { createMissing });
      expect(manageIntentsSchema.parse(p)).toEqual(p);
    }
    expect(parses(withFields("import_csv", { createMissing: "true" }))).toBe(
      false,
    );
  });

  it("import_csv and import_tree: deadlineSeconds is an integer 1-600", () => {
    for (const op of ["import_csv", "import_tree"]) {
      for (const deadlineSeconds of [1, 600]) {
        const p = withFields(op, { deadlineSeconds });
        expect(manageIntentsSchema.parse(p)).toEqual(p);
      }
      for (const deadlineSeconds of [0, 601, 1.5]) {
        expect(parses(withFields(op, { deadlineSeconds }))).toBe(false);
      }
    }
  });

  it("import_tree: accepts the minimal payload and all optional fields", () => {
    const full = withFields("import_tree", {
      sentencesFile: "sentences.csv",
      mode: "replace",
      deadlineSeconds: 120,
    });
    expect(manageIntentsSchema.parse(full)).toEqual(full);
    expect(parses(withFields("import_tree", { mode: "add" }))).toBe(true);
    expect(parses(withFields("import_tree", { mode: "merge" }))).toBe(false);
  });

  it("import_tree: specFile and sentencesFile are 1-500 chars, specFile required", () => {
    expect(parses(withFields("import_tree", {}, ["specFile"]))).toBe(false);
    expect(parses(withFields("import_tree", {}, ["projectId"]))).toBe(false);
    expect(parses(withFields("import_tree", { specFile: "" }))).toBe(false);
    expect(
      parses(withFields("import_tree", { specFile: "f".repeat(500) })),
    ).toBe(true);
    expect(
      parses(withFields("import_tree", { specFile: "f".repeat(501) })),
    ).toBe(false);
    expect(parses(withFields("import_tree", { sentencesFile: "" }))).toBe(
      false,
    );
    expect(
      parses(withFields("import_tree", { sentencesFile: "f".repeat(500) })),
    ).toBe(true);
    expect(
      parses(withFields("import_tree", { sentencesFile: "f".repeat(501) })),
    ).toBe(false);
    expect(parses(withFields("import_tree", { flowId: "bad" }))).toBe(false);
  });

  it("import_sentences: deadlineSeconds is an optional integer from 1 to 600", () => {
    expect(parses(VALID.import_sentences)).toBe(true);
    for (const deadlineSeconds of [1, 60, 600]) {
      const p = withFields("import_sentences", { deadlineSeconds });
      expect(manageIntentsSchema.parse(p)).toEqual(p);
    }
    for (const deadlineSeconds of [0, 601, 1.5, -1, "60"]) {
      expect(parses(withFields("import_sentences", { deadlineSeconds }))).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("manage_intents tool definition", () => {
  const tool = tools.find((t) => t.name === "manage_intents");

  it("is the 20th tool", () => {
    expect(tools).toHaveLength(20);
    expect(tool).toBeDefined();
    expect(tools.filter((t) => t.name === "manage_intents")).toHaveLength(1);
  });

  it("has a description within the budget and without numbered or all-caps lines", () => {
    const d = tool!.description;
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(1000);
    expect(d).not.toMatch(/\n\s*\d+\.\s/);
    expect(d).not.toMatch(/\n[A-Z][A-Z /-]{6,}:/);
  });

  it("says that all six write operations, create included, are held by the backup gate", () => {
    const d = tool!.description;
    expect(d).toContain(
      "create, update, move, delete, import_sentences and build",
    );
    expect(d).toContain("NLU");
    expect(d.toLowerCase()).toContain("backup");
  });

  it("mentions import_csv and import_tree as file-reading operations", () => {
    const d = tool!.description;
    expect(d).toContain("import_csv");
    expect(d).toContain("import_tree");
    expect(d).toContain("file");
  });

  it("is not read-only", () => {
    expect(tool!.annotations.readOnlyHint).toBe(false);
  });

  it("lists exactly the 14 operations and requires operation and flowId", () => {
    const schema = tool!.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.operation.enum).toEqual([
      "list",
      "get",
      "export_tree",
      "below_minimum",
      "compare",
      "model_state",
      "create",
      "update",
      "move",
      "delete",
      "import_sentences",
      "build",
      "import_csv",
      "import_tree",
    ]);
    expect(schema.required).toEqual(["operation", "flowId"]);
  });

  it("declares the 20 named properties (16 original, deadlineSeconds, specFile, sentencesFile, createMissing) with short, non-empty descriptions", () => {
    const props = (tool!.inputSchema as any).properties;
    const names = [
      "flowId",
      "projectId",
      "intent",
      "name",
      "parent",
      "childFeatures",
      "priority",
      "sentences",
      "entries",
      "mode",
      "min",
      "file",
      "includeSentenceCounts",
      "includeStatus",
      "includeSentences",
      "waitSeconds",
      "deadlineSeconds",
      "specFile",
      "sentencesFile",
      "createMissing",
    ];
    expect(names).toHaveLength(20);
    for (const n of names) {
      expect(props[n]).toBeDefined();
      expect(typeof props[n].description).toBe("string");
      expect(props[n].description.length).toBeGreaterThan(0);
      expect(props[n].description.length).toBeLessThanOrEqual(450);
    }
  });

  it("types the new file and createMissing properties", () => {
    const p = (tool!.inputSchema as any).properties;
    expect(p.specFile.type).toBe("string");
    expect(p.specFile.maxLength).toBe(500);
    expect(p.sentencesFile.type).toBe("string");
    expect(p.sentencesFile.maxLength).toBe(500);
    expect(p.createMissing.type).toBe("boolean");
  });

  it("carries the zod limits in the JSON input schema", () => {
    const p = (tool!.inputSchema as any).properties;
    const HEX = "^[a-f0-9]{24}$";
    expect(p.flowId.pattern).toBe(HEX);
    expect(p.projectId.pattern).toBe(HEX);

    expect(p.sentences.maxItems).toBe(200);
    expect(p.sentences.items.type).toBe("string");
    expect(p.sentences.items.minLength).toBe(1);
    expect(p.sentences.items.maxLength).toBe(500);

    expect(p.entries.minItems).toBe(1);
    expect(p.entries.maxItems).toBe(500);
    expect(p.entries.items.type).toBe("object");
    const ep = p.entries.items.properties;
    expect(ep.intent.maxLength).toBe(300);
    expect(ep.intent.minLength).toBe(1);
    expect(ep.sentences.maxItems).toBe(200);
    expect(ep.sentences.items.minLength).toBe(1);
    expect(ep.sentences.items.maxLength).toBe(500);

    expect(p.min.type).toBe("integer");
    expect(p.min.minimum).toBe(1);
    expect(p.min.maximum).toBe(200);
    expect(p.waitSeconds.type).toBe("integer");
    expect(p.waitSeconds.minimum).toBe(0);
    expect(p.waitSeconds.maximum).toBe(300);
    expect(p.deadlineSeconds.type).toBe("integer");
    expect(p.deadlineSeconds.minimum).toBe(1);
    expect(p.deadlineSeconds.maximum).toBe(600);

    expect(p.intent.maxLength).toBe(300);
    expect(p.parent.maxLength).toBe(300);
    expect(p.name.maxLength).toBe(200);
    expect(p.file.maxLength).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Gate, logging, dispatch (through ToolHandlers)
// ---------------------------------------------------------------------------

function makeApi() {
  const emptyList = { items: [], total: 0, nextCursor: null };
  return {
    get: jest.fn(async (): Promise<any> => emptyList),
    post: jest.fn(async (): Promise<any> => ({ _id: INTENT_ID })),
    patch: jest.fn(async (): Promise<any> => ({ _id: INTENT_ID })),
    delete: jest.fn(async (): Promise<any> => ({})),
    put: jest.fn(async (): Promise<any> => ({})),
    uploadFile: jest.fn(async (): Promise<any> => ({})),
  };
}
type FakeApi = ReturnType<typeof makeApi>;
const calls = (api: FakeApi): number =>
  api.get.mock.calls.length +
  api.post.mock.calls.length +
  api.patch.mock.calls.length +
  api.delete.mock.calls.length +
  api.put.mock.calls.length +
  api.uploadFile.mock.calls.length;

describe("manage_intents backup gate", () => {
  let api: FakeApi;
  let h: ToolHandlers;

  beforeEach(() => {
    api = makeApi();
    h = new ToolHandlers(api as any, "https://endpoint-trial.cognigy.ai");
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(WRITE_OPERATIONS)(
    "holds %s on the first call and makes no API call",
    async (op) => {
      const result = await h.handleToolCall("manage_intents", VALID[op]);
      expect(result.error).toBe("backup_not_offered");
      expect(result.tool).toBe("manage_intents");
      expect(result.changed).toBe(false);
      expect(result.projectId).toBe(PROJECT);
      expect(calls(api)).toBe(0);
    },
  );

  it.each(WRITE_OPERATIONS)(
    "lets %s reach the API once the project's backup question is declined",
    async (op) => {
      const declined = await h.handleToolCall("manage_snapshots", {
        operation: "decline",
        projectId: PROJECT,
      });
      expect(declined.acknowledged).toBe(true);
      expect(calls(api)).toBe(0);

      let result: any;
      try {
        result = await h.handleToolCall("manage_intents", VALID[op]);
      } catch {
        // The fake may not satisfy the operation; reaching the API is the point.
      }
      expect(result?.error).not.toBe("backup_not_offered");
      expect(calls(api)).toBeGreaterThan(0);
    },
  );

  it.each(READ_OPERATIONS)(
    "never holds the read operation %s on a first call",
    async (op) => {
      let result: any;
      try {
        result = await h.handleToolCall("manage_intents", VALID[op]);
      } catch {
        // compare reads a file that does not exist; it is still not held.
      }
      expect(result?.error).not.toBe("backup_not_offered");
    },
  );

  it("does not consume the one-shot hold on an invalid write call", async () => {
    await expect(
      h.handleToolCall(
        "manage_intents",
        withFields("create", {}, ["projectId"]),
      ),
    ).rejects.toBeDefined();
    expect(calls(api)).toBe(0);

    const valid = await h.handleToolCall("manage_intents", VALID.create);
    expect(valid.error).toBe("backup_not_offered");
    expect(calls(api)).toBe(0);
  });

  it("does not consume the hold on a schema-invalid update with no changed field", async () => {
    await expect(
      h.handleToolCall("manage_intents", withFields("update", {}, ["name"])),
    ).rejects.toBeDefined();
    const valid = await h.handleToolCall("manage_intents", VALID.update);
    expect(valid.error).toBe("backup_not_offered");
  });

  it.each([
    ["import_csv", "mode"],
    ["import_tree", "specFile"],
  ])(
    "does not consume the hold on an invalid %s call missing %s",
    async (op, missing) => {
      await expect(
        h.handleToolCall("manage_intents", withFields(op, {}, [missing])),
      ).rejects.toBeDefined();
      expect(calls(api)).toBe(0);

      const valid = await h.handleToolCall("manage_intents", VALID[op]);
      expect(valid.error).toBe("backup_not_offered");
      expect(calls(api)).toBe(0);
    },
  );

  it.each(["import_csv", "import_tree"])(
    "keeps the answer per project for %s: declining A still holds B",
    async (op) => {
      await h.handleToolCall("manage_snapshots", {
        operation: "decline",
        projectId: PROJECT,
      });
      const onB = await h.handleToolCall("manage_intents", {
        ...VALID[op],
        projectId: PROJECT_B,
      });
      expect(onB.error).toBe("backup_not_offered");
      expect(onB.projectId).toBe(PROJECT_B);
      expect(calls(api)).toBe(0);
    },
  );

  it("keeps the answer per project: declining A still holds a write on B", async () => {
    await h.handleToolCall("manage_snapshots", {
      operation: "decline",
      projectId: PROJECT,
    });
    const onB = await h.handleToolCall("manage_intents", {
      ...VALID.delete,
      projectId: PROJECT_B,
    });
    expect(onB.error).toBe("backup_not_offered");
    expect(onB.projectId).toBe(PROJECT_B);
    expect(calls(api)).toBe(0);
  });
});

describe("manage_intents logging", () => {
  const SENTINEL_A = "SENTINEL_SENTENCE_ALPHA_zq91";
  const SENTINEL_B = "SENTINEL_SENTENCE_BETA_zq91";
  let api: FakeApi;
  let h: ToolHandlers;
  let spies: ReturnType<typeof jest.spyOn>[];

  const everythingLogged = (): string =>
    JSON.stringify(spies.flatMap((s) => s.mock.calls));

  beforeEach(() => {
    api = makeApi();
    h = new ToolHandlers(api as any, "https://endpoint-trial.cognigy.ai");
    spies = (["info", "debug", "warn", "error"] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("never logs the sentences of an import_sentences call", async () => {
    await h.handleToolCall("manage_snapshots", {
      operation: "decline",
      projectId: PROJECT,
    });
    try {
      await h.handleToolCall("manage_intents", {
        operation: "import_sentences",
        flowId: FLOW,
        projectId: PROJECT,
        mode: "add",
        entries: [{ intent: "Billing", sentences: [SENTINEL_A, SENTINEL_B] }],
      });
    } catch {
      // the outcome does not matter, only what was logged
    }
    const logged = everythingLogged();
    expect(logged).not.toContain(SENTINEL_A);
    expect(logged).not.toContain(SENTINEL_B);
    expect(logged).toContain(FLOW);
    expect(logged).toContain("import_sentences");
    expect(logged).toContain("[REDACTED]");
  });

  it("never logs the sentences of a held import_sentences call either", async () => {
    await h.handleToolCall("manage_intents", {
      operation: "import_sentences",
      flowId: FLOW,
      projectId: PROJECT,
      mode: "replace",
      entries: [{ intent: "Billing", sentences: [SENTINEL_A] }],
    });
    expect(everythingLogged()).not.toContain(SENTINEL_A);
  });

  it("never logs the sentences of a create call", async () => {
    await h.handleToolCall("manage_snapshots", {
      operation: "decline",
      projectId: PROJECT,
    });
    try {
      await h.handleToolCall("manage_intents", {
        operation: "create",
        flowId: FLOW,
        projectId: PROJECT,
        name: "Billing question",
        sentences: [SENTINEL_A, SENTINEL_B],
      });
    } catch {
      // the outcome does not matter, only what was logged
    }
    const logged = everythingLogged();
    expect(logged).not.toContain(SENTINEL_A);
    expect(logged).not.toContain(SENTINEL_B);
    expect(logged).toContain(FLOW);
    expect(logged).toContain("create");
  });

  it("records the redaction on the args of the Handling tool call line", async () => {
    await h.handleToolCall("manage_intents", {
      operation: "create",
      flowId: FLOW,
      projectId: PROJECT,
      name: "Billing question",
      sentences: [SENTINEL_A],
    });
    const info = spies[0].mock.calls.find(([m]) =>
      String(m).startsWith("Handling tool call: manage_intents"),
    );
    expect(info).toBeDefined();
    expect((info![1] as any).args).toEqual({
      operation: "create",
      flowId: FLOW,
      projectId: PROJECT,
      name: "Billing question",
      sentences: "[REDACTED]",
    });
  });

  it("logs file paths normally and still redacts entries and sentences", async () => {
    await h.handleToolCall("manage_intents", {
      operation: "import_csv",
      flowId: FLOW,
      projectId: PROJECT,
      file: "data/sentences.csv",
      mode: "add",
      entries: [{ intent: "Billing", sentences: [SENTINEL_A] }],
      sentences: [SENTINEL_B],
    });
    await h.handleToolCall("manage_intents", {
      operation: "import_tree",
      flowId: FLOW,
      projectId: PROJECT,
      specFile: "data/tree.csv",
      sentencesFile: "data/more.csv",
    });
    const lines = spies[0].mock.calls.filter(([m]) =>
      String(m).startsWith("Handling tool call: manage_intents"),
    );
    expect(lines).toHaveLength(2);
    expect((lines[0][1] as any).args).toEqual({
      operation: "import_csv",
      flowId: FLOW,
      projectId: PROJECT,
      file: "data/sentences.csv",
      mode: "add",
      entries: "[REDACTED]",
      sentences: "[REDACTED]",
    });
    expect((lines[1][1] as any).args).toEqual({
      operation: "import_tree",
      flowId: FLOW,
      projectId: PROJECT,
      specFile: "data/tree.csv",
      sentencesFile: "data/more.csv",
    });
    const logged = everythingLogged();
    expect(logged).not.toContain(SENTINEL_A);
    expect(logged).not.toContain(SENTINEL_B);
  });

  it("still logs non-sensitive args of other tools unredacted", async () => {
    try {
      await h.handleToolCall("list_resources", { resourceType: "project" });
    } catch {
      // the outcome does not matter
    }
    const info = spies[0].mock.calls.find(([m]) =>
      String(m).startsWith("Handling tool call: list_resources"),
    );
    expect(info).toBeDefined();
    expect((info![1] as any).args).toEqual({ resourceType: "project" });
  });
});

describe("manage_intents dispatch", () => {
  let h: ToolHandlers;
  let api: FakeApi;

  beforeEach(() => {
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
    api = makeApi();
    api.get.mockImplementation(async (...a: any[]): Promise<any> => {
      const path = String(a[0]);
      if (path === `/v2.0/flows/${FLOW}/intents`) {
        return {
          items: [
            { _id: INTENT_ID, name: "Billing question", parentIntentId: null },
          ],
          total: 1,
          nextCursor: null,
        };
      }
      return { _id: INTENT_ID, childFeatures: true };
    });
    h = new ToolHandlers(api as any, "https://endpoint-trial.cognigy.ai");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("list returns the fake's single intent and total, un-held, with no write", async () => {
    const result = await h.handleToolCall("manage_intents", {
      operation: "list",
      flowId: FLOW,
      includeSentenceCounts: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.operation).toBe("list");
    expect(result.flowId).toBe(FLOW);
    expect(result.total).toBe(1);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].id).toBe(INTENT_ID);
    expect(result.intents[0].name).toBe("Billing question");
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalled();
  });

  it("rejects an unknown operation without reaching the API", async () => {
    await expect(
      h.handleToolCall("manage_intents", {
        operation: "frobnicate",
        flowId: FLOW,
      }),
    ).rejects.toBeDefined();
    expect(calls(api)).toBe(0);
  });

  it("rejects a schema-invalid read without reaching the API", async () => {
    await expect(
      h.handleToolCall("manage_intents", { operation: "list", flowId: "bad" }),
    ).rejects.toBeDefined();
    expect(calls(api)).toBe(0);
  });
});
