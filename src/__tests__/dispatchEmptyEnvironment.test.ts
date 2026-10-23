/**
 * An empty or whitespace-only `environment` argument must never be silently
 * resolved when the session could route it somewhere (a pin, or two or more
 * environments). Only a lone environment with no pin tolerates it as omitted.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  ALL_KEYS,
  KEY_A,
  KEY_B,
  harness,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import type { ToolResult } from "../server/dispatch.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const ONE = () => setOf(usable("A", KEY_A));
const BLANKS = [[""], ["   "]] as const;

type Harness = ReturnType<typeof harness>;

const handlerCallCount = (h: Harness): number =>
  Object.values(h.handlerCalls).reduce((n, m) => n + m.mock.calls.length, 0);

/** D6: nothing was served and no secret leaked. */
function expectNothingServed(r: ToolResult): void {
  expect(r.isError).toBe(true);
  const body = parse(r);
  expect("_environment" in body).toBe(false);
  const text = JSON.stringify(r);
  expect(text).not.toContain("_environment");
  for (const k of ALL_KEYS) expect(text).not.toContain(k);
}

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("D1: two environments, no pin", () => {
  it.each(BLANKS)(
    "refuses environment %j with the same shape as an omitted argument",
    async (blank) => {
      const h = harness({ set: TWO(), session: true });
      const omitted = await h.dispatcher.callTool("alpha", { x: "1" });
      const r = await h.dispatcher.callTool("alpha", {
        environment: blank,
        x: "1",
      });
      // Killing mutation: blank routed/ignored (handler runs) or a different
      // refusal code/fields/available list.
      expect(handlerCallCount(h)).toBe(0);
      expectNothingServed(r);
      const body = parse(r);
      const ref = parse(omitted);
      expect(ref.code).toBe("ambiguous");
      expect(body.code).toBe("ambiguous");
      expect(body.available).toEqual(["a", "b"]);
      expect(Object.keys(body).sort()).toEqual(Object.keys(ref).sort());
      expect(r.isError).toBe(omitted.isError);
    },
  );
});

describe("D2: two environments, pinned", () => {
  it.each(BLANKS)(
    "refuses environment %j instead of routing to the pin",
    async (blank) => {
      const h = harness({ set: TWO(), session: true });
      await h.dispatcher.callTool("use_environment", { name: "b" });
      const r = await h.dispatcher.callTool("alpha", {
        environment: blank,
        x: "1",
      });
      // Killing mutation: blank treated as omitted -> served by pinned b.
      expect(handlerCallCount(h)).toBe(0);
      expectNothingServed(r);
      const msg = String(parse(r).error);
      expect(msg).toMatch(/empty/i);
      expect(msg).toMatch(/environment/i);
    },
  );

  it("regression: the pin still serves a call that omits environment", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("alpha", { x: "1" });
    // Killing mutation: over-eager refusal that also blocks omitted args.
    expect(r.isError).toBeUndefined();
    expect(parse(r)._environment).toMatchObject({ name: "b" });
    expect(h.handlerCalls["b"].mock.calls).toEqual([["alpha", { x: "1" }]]);
    expect(h.handlerCalls["a"]?.mock.calls ?? []).toEqual([]);
  });

  it("regression: an explicit valid name still overrides the pin", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("alpha", {
      environment: "a",
      x: "1",
    });
    // Killing mutation: pin overriding an explicit name.
    expect(r.isError).toBeUndefined();
    expect(parse(r)._environment).toMatchObject({ name: "a" });
    expect(h.handlerCalls["a"].mock.calls).toEqual([["alpha", { x: "1" }]]);
    expect(h.handlerCalls["b"]?.mock.calls ?? []).toEqual([]);
  });
});

describe("D3: one environment, pinned", () => {
  it.each(BLANKS)("refuses environment %j", async (blank) => {
    const h = harness({ set: ONE(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "a" });
    expect(h.pin.get()?.name).toBe("a");
    const r = await h.dispatcher.callTool("alpha", {
      environment: blank,
      x: "1",
    });
    // Killing mutation: pin (or sole env) silently resolves the blank.
    expect(handlerCallCount(h)).toBe(0);
    expectNothingServed(r);
    expect(String(parse(r).error)).toMatch(/empty/i);
  });
});

describe("D4: one environment, no pin", () => {
  it.each(BLANKS)("treats environment %j as omitted", async (blank) => {
    const h = harness({ set: ONE(), session: true });
    const r = await h.dispatcher.callTool("alpha", {
      environment: blank,
      x: "1",
    });
    // Killing mutation: refusing blank when nothing could be misrouted.
    expect(r.isError).toBeUndefined();
    expect(parse(r)._environment).toMatchObject({ name: "a" });
    expect(h.handlerCalls["a"].mock.calls).toEqual([["alpha", { x: "1" }]]);
  });
});

describe("D5: exempt tools keep their behaviour", () => {
  it("use_environment with environment '' does not crash or run a tool handler", async () => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("use_environment", {
      environment: "",
      name: "a",
    });
    // Killing mutation: blank check applied to exempt tools reaching handlers.
    expect(r).toBeDefined();
    expect(Array.isArray(r.content)).toBe(true);
    expect(handlerCallCount(h)).toBe(0);
  });

  it("list_environments with environment '' does not crash or run a tool handler", async () => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("list_environments", {
      environment: "",
    });
    // Killing mutation: list_environments dispatched to a tool handler.
    expect(r).toBeDefined();
    expect(Array.isArray(r.content)).toBe(true);
    expect(handlerCallCount(h)).toBe(0);
  });
});
