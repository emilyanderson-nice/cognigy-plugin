import { describe, it } from "@jest/globals";
import type { ToolDefinition } from "../server/dispatch.js";
import {
  LIST_ENV_TOOL,
  broken,
  deepFreeze,
  harness,
  KEY_A,
  KEY_B,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const ONE = () => setOf(usable("A", KEY_A));

function envProp(t: ToolDefinition): Record<string, unknown> | undefined {
  return (t.inputSchema.properties as Record<string, unknown> | undefined)
    ?.environment as Record<string, unknown> | undefined;
}
const byName = (list: ToolDefinition[], n: string): ToolDefinition =>
  list.find((t) => t.name === n) as ToolDefinition;

describe("dispatcher.listTools", () => {
  it("L1: never mutates the input tools and returns fresh objects", () => {
    const input = deepFreeze([
      tool("alpha"),
      tool("beta", { inputSchema: { type: "object" } }),
    ]);
    const snapshotBefore = JSON.stringify(input);
    const h = harness({ set: TWO(), tools: input });
    const out = h.dispatcher.listTools();
    eq(
      JSON.stringify(input),
      snapshotBefore,
      "listTools input immutability",
      "L1: deps.tools is never mutated",
      "Return modified copies and leave the supplied definitions untouched.",
    );
    for (const t of out) {
      ok(
        !input.includes(t as never),
        "listTools returns clones",
        "L1: returned objects are not the input references",
        "no returned tool is a supplied object",
        `${t.name} is the same reference`,
        "Return new objects for each tool.",
      );
      ok(
        !input.some((i) => i.inputSchema === t.inputSchema),
        "listTools clones inputSchema",
        "L1: nested schema is a copy",
        "inputSchema is a different object",
        `${t.name} shares inputSchema`,
        "Copy the schema before adding the environment argument.",
      );
    }
  });

  it("L1: adds an environment property with a descriptive text to every tool but list_environments", () => {
    const h = harness({ set: TWO(), tools: [tool("alpha"), tool("beta")] });
    const out = h.dispatcher.listTools();
    for (const n of ["alpha", "beta"]) {
      const p = envProp(byName(out, n));
      eq(
        p?.type,
        "string",
        `${n} environment type`,
        "L1: environment is a string argument",
        "Declare the environment argument as a string.",
      );
      const d = String(p?.description ?? "");
      ok(
        d.length > 0 &&
          /environment/i.test(d) &&
          /required/i.test(d) &&
          /optional/i.test(d) &&
          d.includes("list_environments") &&
          /more than one|two or more|multiple/i.test(d),
        `${n} environment description`,
        "L1: description explains selection, requiredness and list_environments",
        "text saying it selects the Cognigy environment, is required when more than one is configured, optional otherwise, and mentions list_environments",
        JSON.stringify(d),
        "Write a description covering all of those points.",
      );
    }
    const le = byName(out, "list_environments");
    eq(
      envProp(le),
      undefined,
      "list_environments schema",
      "L1: list_environments gets no environment property",
      "Leave the list_environments definition unchanged.",
    );
  });

  it("L1: preserves existing properties and the original required entries in order, and with two or more environments appends environment", () => {
    const withReq = tool("withReq", {
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "string" } },
        required: ["a"],
      },
    });
    const noReq = tool("noReq");
    const noProps = tool("noProps", { inputSchema: { type: "object" } });
    const h = harness({ set: TWO(), tools: [withReq, noReq, noProps] });
    const out = h.dispatcher.listTools();
    const w = byName(out, "withReq");
    eq(
      w.inputSchema.required,
      ["a", "environment"],
      "required keeps originals then environment",
      "L1: with two environments required is the original entries in order followed by environment exactly once",
      "Keep the original required entries in order and append environment last, once.",
    );
    const oneOut = harness({
      set: ONE(),
      tools: [withReq, noReq, noProps],
    }).dispatcher.listTools();
    eq(
      byName(oneOut, "withReq").inputSchema.required,
      ["a"],
      "required exactly as declared with one environment",
      "L1: with one environment required is exactly as the tool declared it",
      "Do not add environment to required unless two or more environments exist.",
    );
    eq(
      { a: w.inputSchema.properties?.a, b: w.inputSchema.properties?.b },
      { a: { type: "number" }, b: { type: "string" } },
      "existing properties preserved",
      "L1: existing properties kept",
      "Keep every existing property exactly as supplied.",
    );
    eq(
      byName(out, "noReq").inputSchema.required,
      ["environment"],
      "absent required becomes [environment] with two environments",
      "L1: a tool with no required array gets exactly [environment] when two or more environments exist",
      "Create required holding only environment.",
    );
    eq(
      byName(out, "noProps").inputSchema.required,
      ["environment"],
      "absent required becomes [environment] (no props) with two environments",
      "L1: a tool with no required array gets exactly [environment] when two or more environments exist",
      "Create required holding only environment.",
    );
    for (const n of ["noReq", "noProps"]) {
      ok(
        !("required" in byName(oneOut, n).inputSchema),
        `absent required stays absent with one environment (${n})`,
        "L1: with one environment no required array is introduced",
        "no required key",
        "required key present",
        "Do not introduce a required array unless two or more environments exist.",
      );
    }
    eq(
      Object.keys(byName(out, "noProps").inputSchema.properties ?? {}),
      ["environment"],
      "tool without properties",
      "L1: a properties object is created holding environment",
      "Create properties when absent.",
    );
    eq(
      Object.keys(byName(out, "noReq").inputSchema.properties ?? {}).sort(),
      ["environment", "x"],
      "noReq properties",
      "L1: existing x plus environment",
      "Only environment is added.",
    );
  });

  it("L1: enum is the sorted configured names (usable + broken) when two or more are configured", () => {
    const h = harness({
      set: setOf(usable("ZED", KEY_A), usable("A", KEY_B), broken("MID")),
    });
    const p = envProp(byName(h.dispatcher.listTools(), "alpha"));
    eq(
      p?.enum,
      ["a", "mid", "zed"],
      "environment enum",
      "L1: enum = sorted configuredNames incl. broken",
      "List every configured name, sorted, including unusable ones.",
    );
  });

  it("L1: no enum with exactly one or zero configured environments", () => {
    for (const set of [ONE(), setOf()]) {
      const h = harness({ set });
      const p = envProp(byName(h.dispatcher.listTools(), "alpha"));
      ok(
        p !== undefined && !("enum" in p),
        "enum omitted",
        "L1: enum only when two or more configured",
        "environment property present without enum",
        JSON.stringify(p),
        "Omit enum for zero or one configured environment.",
      );
    }
    const h = harness({ set: setOf(usable("A", KEY_A), broken("B")) });
    eq(
      envProp(byName(h.dispatcher.listTools(), "alpha"))?.enum,
      ["a", "b"],
      "usable plus broken counts as two",
      "L1: broken environments count toward the enum threshold",
      "Count configured names, not just usable profiles.",
    );
  });

  it("L1: appends list_environments exactly once, unchanged, after the others in order", () => {
    const h = harness({
      set: TWO(),
      tools: [tool("c"), tool("a"), tool("b")],
    });
    const names = h.dispatcher.listTools().map((t) => t.name);
    eq(
      names,
      ["c", "a", "b", "list_environments"],
      "tool order",
      "L1: order preserved, list_environments last",
      "Keep input order and append list_environments at the end.",
    );
    eq(
      byName(h.dispatcher.listTools(), "list_environments"),
      LIST_ENV_TOOL,
      "list_environments definition",
      "L1: injected definition returned unchanged",
      "Return deps.listEnvironmentsTool as supplied.",
    );
  });

  it("L1: an existing list_environments entry is replaced, never duplicated", () => {
    const stale = tool("list_environments", { description: "STALE" });
    const h = harness({ set: TWO(), tools: [tool("a"), stale, tool("b")] });
    const out = h.dispatcher.listTools();
    eq(
      out.filter((t) => t.name === "list_environments").length,
      1,
      "list_environments count",
      "L1: no duplicates",
      "Only one list_environments definition may be returned.",
    );
    eq(
      byName(out, "list_environments").description,
      LIST_ENV_TOOL.description,
      "list_environments source",
      "L1: injected definition replaces the supplied one",
      "Prefer the injected definition.",
    );
    eq(
      out.filter((t) => t.name !== "list_environments").map((t) => t.name),
      ["a", "b"],
      "other tools keep order",
      "L1: order of other tools preserved",
      "Do not reorder other tools.",
    );
  });

  it("L1: re-reads the registry on every call (new environment appears in the next enum)", () => {
    const h = harness({ set: ONE() });
    ok(
      !("enum" in (envProp(byName(h.dispatcher.listTools(), "alpha")) ?? {})),
      "first listTools",
      "L1: one environment, no enum",
      "no enum",
      "enum present",
      "Compute the enum on each call.",
    );
    h.setSet(TWO());
    eq(
      envProp(byName(h.dispatcher.listTools(), "alpha"))?.enum,
      ["a", "b"],
      "second listTools",
      "L1: snapshot re-read per call",
      "Re-read the environment list on every call.",
    );
  });
});
