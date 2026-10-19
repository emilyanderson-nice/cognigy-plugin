import { describe, it } from "@jest/globals";
import type { ToolDefinition } from "../server/dispatch.js";
import {
  broken,
  deepFreeze,
  harness,
  KEY_A,
  LIST_ENV_TOOL,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

type Harness = ReturnType<typeof harness>;

/** Makes the registry report exactly these configured names, keeping the rest of the snapshot. */
function setNames(h: Harness, names: string[]): void {
  const real = h.registry.snapshot.getMockImplementation() as () => {
    configuredNames: string[];
  };
  const base = real();
  h.registry.snapshot.mockImplementation((() => ({
    ...base,
    configuredNames: names,
  })) as never);
}

const withReq = (): ToolDefinition =>
  tool("withReq", {
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  });
const noReq = (): ToolDefinition => tool("noReq");
const dup = (): ToolDefinition =>
  tool("dup", {
    inputSchema: {
      type: "object",
      properties: { environment: { type: "string" } },
      required: ["environment"],
    },
  });
const multiReq = (): ToolDefinition =>
  tool("multiReq", {
    inputSchema: {
      type: "object",
      properties: { z: { type: "string" }, a: { type: "string" } },
      required: ["z", "a"],
    },
  });

const byName = (list: ToolDefinition[], n: string): ToolDefinition =>
  list.find((t) => t.name === n) as ToolDefinition;
const reqOf = (t: ToolDefinition): unknown => t.inputSchema.required;

function build(names: string[], tools: ToolDefinition[]): Harness {
  const h = harness({ set: setOf(usable("A", KEY_A)), tools });
  setNames(h, names);
  return h;
}

describe("dispatcher.listTools environment requiredness", () => {
  it("R1: with two configured names every non-list_environments tool requires environment, appended in order", () => {
    const h = build(
      ["a", "b"],
      [withReq(), noReq(), dup(), multiReq(), tool("plain")],
    );
    const out = h.dispatcher.listTools();
    for (const t of out.filter((x) => x.name !== "list_environments")) {
      const r = reqOf(t) as string[] | undefined;
      ok(
        Array.isArray(r) && r.includes("environment"),
        `${t.name} required`,
        "R1: environment is required when more than one environment is configured",
        'required contains "environment"',
        JSON.stringify(r),
        "Add environment to required whenever two or more environments are configured.",
      );
    }
    eq(
      reqOf(byName(out, "withReq")),
      ["q", "environment"],
      "existing required kept, environment appended",
      "R1: existing entries preserved in order",
      "Append environment after the existing required entries.",
    );
    eq(
      reqOf(byName(out, "multiReq")),
      ["z", "a", "environment"],
      "multi-entry required order",
      "R1: existing order preserved, environment last",
      "Do not sort or reorder existing required entries.",
    );
    eq(
      reqOf(byName(out, "noReq")),
      ["environment"],
      "tool without required",
      "R1: a required array is created holding only environment",
      "Create required as exactly [environment] when none existed.",
    );
    eq(
      reqOf(byName(out, "dup")),
      ["environment"],
      "already-required environment",
      "R1: no duplicate entry",
      "Do not add environment twice.",
    );
  });

  it("R2: with exactly one configured name environment is not required and required is untouched", () => {
    const h = build(["a"], [withReq(), noReq(), dup()]);
    const out = h.dispatcher.listTools();
    for (const t of out.filter(
      (x) => x.name !== "list_environments" && x.name !== "dup",
    )) {
      const r = reqOf(t) as string[] | undefined;
      ok(
        !(r ?? []).includes("environment"),
        `${t.name} required`,
        "R2: a single configured environment is selected implicitly",
        'required does not contain "environment"',
        JSON.stringify(r),
        "Only require environment when more than one is configured.",
      );
    }
    eq(
      reqOf(byName(out, "withReq")),
      ["q"],
      "required preserved with one name",
      "R2: required exactly as supplied",
      "Leave required untouched.",
    );
    ok(
      !("required" in byName(out, "noReq").inputSchema),
      "absent required stays absent with one name",
      "R2: no empty required array is created",
      "no required key",
      "required key present",
      "Do not introduce a required array.",
    );
    eq(
      reqOf(byName(out, "dup")),
      ["environment"],
      "supplied required not stripped",
      "R2: supplied required is never altered",
      "Keep a supplied required entry even when one environment is configured.",
    );
  });

  it("R2: with zero configured names environment is not required and required is untouched", () => {
    const h = build([], [withReq(), noReq()]);
    const out = h.dispatcher.listTools();
    eq(
      reqOf(byName(out, "withReq")),
      ["q"],
      "required preserved with zero names",
      "R2: required exactly as supplied",
      "Leave required untouched.",
    );
    ok(
      !("required" in byName(out, "noReq").inputSchema),
      "absent required stays absent with zero names",
      "R2: no empty required array is created",
      "no required key",
      "required key present",
      "Do not introduce a required array.",
    );
  });

  it("R3: a broken profile still counts toward requiring environment", () => {
    const h = harness({
      set: setOf(usable("A", KEY_A), broken("B")),
      tools: [withReq(), noReq()],
    });
    const snap = h.registry.snapshot() as unknown as {
      configuredNames: string[];
      problems: unknown[];
      profiles: unknown[];
    };
    ok(
      snap.configuredNames.length === 2 &&
        snap.problems.length >= 1 &&
        snap.profiles.length === 1,
      "fixture sanity",
      "R3: fixture has two configured names, one broken, one usable",
      "2 configured, >=1 problem, 1 usable profile",
      JSON.stringify({
        names: snap.configuredNames,
        problems: snap.problems.length,
        profiles: snap.profiles.length,
      }),
      "Fix the test fixture.",
    );
    const out = h.dispatcher.listTools();
    eq(
      reqOf(byName(out, "withReq")),
      ["q", "environment"],
      "broken counts: withReq",
      "R3: configured names include unusable profiles",
      "Count configured names, not just usable profiles.",
    );
    eq(
      reqOf(byName(out, "noReq")),
      ["environment"],
      "broken counts: noReq",
      "R3: configured names include unusable profiles",
      "Count configured names, not just usable profiles.",
    );
  });

  it("R4: list_environments is untouched with two names and with one name", () => {
    for (const names of [["a", "b"], ["a"]]) {
      const h = build(names, [withReq()]);
      const le = byName(h.dispatcher.listTools(), "list_environments");
      eq(
        le.inputSchema,
        LIST_ENV_TOOL.inputSchema,
        `list_environments schema with ${names.length} names`,
        "R4: list_environments schema equals the injected definition",
        "Leave list_environments exactly as supplied.",
      );
      ok(
        !("required" in le.inputSchema) &&
          !("environment" in (le.inputSchema.properties ?? {})),
        `list_environments has no required/environment (${names.length} names)`,
        "R4: list_environments never takes or requires environment",
        "no required key and no environment property",
        JSON.stringify(le.inputSchema),
        "Do not add environment to list_environments.",
      );
    }
  });

  it("R5: input definitions are never mutated, even when environment becomes required", () => {
    const input = [withReq(), noReq(), dup()];
    const before = structuredClone(input);
    const h = build(["a", "b"], input);
    h.dispatcher.listTools();
    eq(
      input,
      before,
      "input immutability",
      "R5: supplied definitions are not modified",
      "Copy required before appending environment.",
    );
  });

  it("R5: input definitions are never mutated even when deeply frozen", () => {
    const input = deepFreeze([withReq(), noReq()]);
    const h = build(["a", "b"], input);
    const out = h.dispatcher.listTools();
    eq(
      reqOf(byName(out, "withReq")),
      ["q", "environment"],
      "frozen input still handled",
      "R5: requiredness computed on copies",
      "Do not write to supplied schemas.",
    );
  });

  it("R5: requiredness follows the current registry snapshot on every call (no caching)", () => {
    const h = build(["a", "b"], [withReq(), noReq()]);
    const first = h.dispatcher.listTools();
    eq(
      reqOf(byName(first, "withReq")),
      ["q", "environment"],
      "call 1 (two names)",
      "R5: required when two names are configured",
      "Compute requiredness from the current snapshot.",
    );
    setNames(h, ["a"]);
    const second = h.dispatcher.listTools();
    eq(
      reqOf(byName(second, "withReq")),
      ["q"],
      "call 2 (one name)",
      "R5: not required once only one name is configured",
      "Re-read the registry on each call.",
    );
    ok(
      !("required" in byName(second, "noReq").inputSchema),
      "call 2 noReq has no required",
      "R5: required key absent again with one name",
      "no required key",
      "required key present",
      "Do not carry requiredness over from the previous call.",
    );
    setNames(h, ["a", "b", "c"]);
    const third = h.dispatcher.listTools();
    eq(
      reqOf(byName(third, "withReq")),
      ["q", "environment"],
      "call 3 (three names)",
      "R5: required again with three names, appended once",
      "Re-read the registry on each call and never accumulate duplicates.",
    );
    eq(
      reqOf(byName(first, "withReq")),
      ["q", "environment"],
      "earlier result unaffected",
      "R5: earlier results are independent copies",
      "Return fresh objects per call.",
    );
  });

  it("R6: the environment property still carries the sorted names as enum with two names", () => {
    const h = build(["a", "b"], [withReq()]);
    const p = (
      byName(h.dispatcher.listTools(), "withReq").inputSchema
        .properties as Record<string, Record<string, unknown>>
    ).environment;
    eq(
      p?.enum,
      ["a", "b"],
      "environment enum",
      "R6: enum still lists configured names",
      "Keep the enum behaviour unchanged.",
    );
    ok(
      p?.type === "string" && /required/i.test(String(p?.description ?? "")),
      "environment property shape",
      "R6: string type and descriptive text retained",
      "type string with a description mentioning required",
      JSON.stringify(p),
      "Keep the existing property definition.",
    );
  });
});
