/**
 * Session pinning: a session can be pinned to one environment, either at
 * launch (COGNIGY_ENVIRONMENT) or with the use_environment tool, so calls
 * without an `environment` argument route there. An explicit argument still
 * wins; a pin that stops resolving fails closed, never falls back.
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
  USE_ENVIRONMENT_TOOL,
  createSessionPin,
} from "../environments/sessionPin.js";
import { createListEnvironments } from "../environments/listEnvironments.js";
import { createEnvironmentRegistry } from "../environments/registry.js";
import { rig } from "./helpers/bootstrapRig.js";
import {
  ALL_KEYS,
  KEY_A,
  KEY_B,
  broken,
  harness,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import type { ToolResult } from "../server/dispatch.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));

const noKeys = (r: ToolResult | Record<string, unknown>) => {
  const s = JSON.stringify(r);
  for (const k of ALL_KEYS) expect(s).not.toContain(k);
};

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("USE_ENVIRONMENT_TOOL definition", () => {
  it("takes name or clear, nothing else, and is idempotent session state", () => {
    const t = USE_ENVIRONMENT_TOOL;
    expect(t.name).toBe("use_environment");
    expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual([
      "clear",
      "name",
    ]);
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(t.inputSchema.required).toBeUndefined();
    expect(t.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(t.description).toMatch(/pin/i);
    expect(t.description).toMatch(/never returns API keys/i);
  });
});

describe("use_environment through the dispatcher", () => {
  it("is listed after list_environments, without an environment property", () => {
    const h = harness({ set: TWO(), session: true });
    const out = h.dispatcher.listTools();
    expect(out.map((t) => t.name)).toEqual([
      "alpha",
      "talk_to_agent",
      "list_environments",
      "use_environment",
    ]);
    const ue = out.find((t) => t.name === "use_environment");
    expect(ue?.inputSchema.properties?.environment).toBeUndefined();
    const desc = String(
      (out[0].inputSchema.properties?.environment as { description: string })
        .description,
    );
    expect(desc).toMatch(/pinned/i);
    expect(desc).toMatch(/use_environment/);
  });

  it("pins with the registry's name normalisation and returns name and host, no key", async () => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("use_environment", { name: "  B " });
    expect(r.isError).toBeUndefined();
    expect(parse(r)).toEqual({
      pinned: {
        name: "b",
        host: "api-b.cognigy.ai",
        source: "use_environment",
      },
      previous: null,
    });
    noKeys(r);
    expect(h.pin.get()).toEqual({ name: "b", source: "use_environment" });
    expect(h.rateLimiter.check.mock.calls).toEqual([["__use_environment"]]);
  });

  it("is exempt from the environment-required rule and runs no tool handler", async () => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("use_environment", { name: "a" });
    expect(r.isError).toBeUndefined();
    expect(
      Object.values(h.handlerCalls).every((m) => m.mock.calls.length === 0),
    ).toBe(true);
  });

  it("an unknown name is refused, lists the available names, and keeps the pin", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "a" });
    const r = await h.dispatcher.callTool("use_environment", { name: "nope" });
    const body = parse(r);
    expect(r.isError).toBe(true);
    expect(body.code).toBe("unknown");
    expect(body.available).toEqual(["a", "b"]);
    expect(String(body.error)).toMatch(/nope/);
    expect(String(body.error)).toMatch(/a, b/);
    expect(h.pin.get()?.name).toBe("a");
  });

  it("a broken environment is refused with its reason", async () => {
    const h = harness({
      set: setOf(usable("A", KEY_A), broken("Z")),
      session: true,
    });
    const r = await h.dispatcher.callTool("use_environment", { name: "z" });
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("broken");
    expect(h.pin.get()).toBeUndefined();
    noKeys(r);
  });

  it.each([
    [{}],
    [{ name: "" }],
    [{ name: "   " }],
    [{ name: 3 }],
    [{ clear: false }],
    [{ clear: "yes" }],
    [{ name: "a", clear: true }],
  ])("rejects bad arguments %j", async (args) => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("use_environment", args);
    expect(r.isError).toBe(true);
    expect(String(parse(r).error)).toMatch(/name|clear/);
    expect(h.pin.get()).toBeUndefined();
  });

  it("clear: true removes the pin and says which one was cleared", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("use_environment", { clear: true });
    expect(parse(r)).toEqual({ pinned: null, cleared: "b" });
    expect(h.pin.get()).toBeUndefined();
    const again = await h.dispatcher.callTool("use_environment", {
      clear: true,
    });
    expect(parse(again)).toEqual({ pinned: null, cleared: null });
  });

  it("reports the previous pin when switching", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "a" });
    const r = await h.dispatcher.callTool("use_environment", { name: "b" });
    expect(parse(r).previous).toBe("a");
  });
});

describe("routing with a pin", () => {
  it("a call without environment goes to the pinned environment and is stamped", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("alpha", { x: "1" });
    expect(r.isError).toBeUndefined();
    expect(parse(r)._environment).toEqual({
      name: "b",
      host: "api-b.cognigy.ai",
    });
    expect(h.handlerCalls.b.mock.calls).toEqual([["alpha", { x: "1" }]]);
    expect(h.handlerCalls.a).toBeUndefined();
  });

  it("an empty environment argument counts as absent and uses the pin", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("alpha", { environment: " " });
    expect((parse(r)._environment as { name: string }).name).toBe("b");
  });

  it("an explicit environment argument wins over the pin and leaves it in place", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    const r = await h.dispatcher.callTool("alpha", { environment: "a" });
    expect((parse(r)._environment as { name: string }).name).toBe("a");
    expect(h.handlerCalls.a.mock.calls.length).toBe(1);
    expect(h.pin.get()?.name).toBe("b");
  });

  it("without a pin, two environments still require the argument", async () => {
    const h = harness({ set: TWO(), session: true });
    const r = await h.dispatcher.callTool("alpha", {});
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("ambiguous");
  });

  it("a pinned environment removed from the profiles fails closed, even with one environment left", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    h.setSet(setOf(usable("A", KEY_A)));
    const r = await h.dispatcher.callTool("alpha", {});
    const body = parse(r);
    expect(r.isError).toBe(true);
    expect(body.code).toBe("unknown");
    expect(body.environment).toBe("b");
    expect(body.available).toEqual(["a"]);
    expect(body.pinned).toEqual({ name: "b", source: "use_environment" });
    expect(String(body.error)).toMatch(/pinned/i);
    expect(String(body.error)).toMatch(/"b"/);
    expect(String(body.error)).toMatch(/use_environment/);
    expect(h.handlerCalls.a).toBeUndefined();
    expect(h.pin.get()?.name).toBe("b");
  });

  it("a pinned environment that becomes broken fails closed with the reason", async () => {
    const h = harness({ set: TWO(), session: true });
    await h.dispatcher.callTool("use_environment", { name: "b" });
    h.setSet(setOf(usable("A", KEY_A), broken("B")));
    const r = await h.dispatcher.callTool("alpha", {});
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("broken");
    expect(h.handlerCalls.a).toBeUndefined();
    noKeys(r);
  });
});

describe("launch pin (COGNIGY_ENVIRONMENT)", () => {
  it("pins the session at boot with name normalisation", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: " B " });
    expect(r.parts.startupNotices()).toEqual([]);
    const res = await r.call("list_resources");
    expect((parse(res)._environment as { name: string }).name).toBe("b");
    expect(r.handlerCalls.b.mock.calls.length).toBe(1);
  });

  it("list_environments marks the pinned environment and its source", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: "b" });
    const list = parse(await r.call("list_environments"));
    const envs = list.environments as Array<{ name: string; pinned: boolean }>;
    expect(envs.map((e) => [e.name, e.pinned])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(list.pin).toEqual({ name: "b", source: "COGNIGY_ENVIRONMENT" });
    expect(list.environmentArgumentRequired).toBe(false);
  });

  it("use_environment replaces the launch pin and list_environments reports the new source", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: "b" });
    await r.call("use_environment", { name: "a" });
    const list = parse(await r.call("list_environments"));
    expect(list.pin).toEqual({ name: "a", source: "use_environment" });
  });

  it.each([[""], ["   "]])(
    "an empty value (%j) is treated as unset",
    async (v) => {
      const r = rig(TWO(), { COGNIGY_ENVIRONMENT: v });
      expect(r.parts.startupNotices()).toEqual([]);
      expect(parse(await r.call("list_resources")).code).toBe("ambiguous");
      expect(parse(await r.call("list_environments")).pin).toBeNull();
    },
  );

  it("an unknown value does not crash: warns, leaves no pin, and pin-reliant calls fail naming it", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: "nope" });
    const notices = r.parts.startupNotices();
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/COGNIGY_ENVIRONMENT/);
    expect(notices[0]).toMatch(/"nope"/);
    expect(notices[0]).toMatch(/a, b/);

    const res = await r.call("list_resources");
    const body = parse(res);
    expect(res.isError).toBe(true);
    expect(body.code).toBe("pin_invalid");
    expect(body.environment).toBe("nope");
    expect(body.available).toEqual(["a", "b"]);
    expect(String(body.error)).toMatch(/COGNIGY_ENVIRONMENT="nope"/);
    expect(String(body.error)).toMatch(/a, b/);
    expect(Object.keys(r.handlerCalls)).toEqual([]);

    const list = parse(await r.call("list_environments"));
    expect(list.pin).toBeNull();
    expect((list.pinRejected as { value: string }).value).toBe("nope");
  });

  it("an unknown value fails pin-reliant calls even with a single environment configured", async () => {
    const r = rig(setOf(usable("A", KEY_A)), { COGNIGY_ENVIRONMENT: "nope" });
    const res = await r.call("list_resources");
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("pin_invalid");
    expect(Object.keys(r.handlerCalls)).toEqual([]);
  });

  it("with an unknown value an explicit environment still works, and use_environment or clear recovers", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: "nope" });
    const explicit = await r.call("list_resources", { environment: "a" });
    expect(explicit.isError).toBeUndefined();

    await r.call("use_environment", { name: "b" });
    const pinned = await r.call("list_resources");
    expect((parse(pinned)._environment as { name: string }).name).toBe("b");
    expect(
      parse(await r.call("list_environments")).pinRejected,
    ).toBeUndefined();

    await r.call("use_environment", { clear: true });
    expect(parse(await r.call("list_resources")).code).toBe("ambiguous");
  });

  it("a broken value is refused with the reason and leaves no pin", async () => {
    const r = rig(setOf(usable("A", KEY_A), broken("Z")), {
      COGNIGY_ENVIRONMENT: "z",
    });
    expect(r.parts.startupNotices()[0]).toMatch(/unusable/);
    const res = await r.call("list_resources");
    expect(parse(res).code).toBe("pin_invalid");
    noKeys(res);
    noKeys({ n: r.parts.startupNotices() });
  });

  it("a launch-pinned environment removed later fails closed, naming the source", async () => {
    const r = rig(TWO(), { COGNIGY_ENVIRONMENT: "b" });
    r.set(setOf(usable("A", KEY_A)));
    const res = await r.call("list_resources");
    const body = parse(res);
    expect(res.isError).toBe(true);
    expect(body.pinned).toEqual({ name: "b", source: "COGNIGY_ENVIRONMENT" });
    expect(String(body.error)).toMatch(/COGNIGY_ENVIRONMENT/);
    expect(r.handlerCalls.a).toBeUndefined();
  });
});

describe("createListEnvironments with a pin", () => {
  it("marks every environment pinned true/false and reports pin: null when unpinned", async () => {
    const registry = createEnvironmentRegistry({
      loadProfiles: () => TWO(),
      createRuntime: (profile) => ({
        profile,
        client: {},
        handlers: { handleToolCall: async () => ({}) },
      }),
    });
    const pin = createSessionPin();
    const list = createListEnvironments({
      registry,
      detectRelease: async () => ({ source: "none" }) as never,
      pin,
    });
    const before = await list({});
    expect(
      (before.environments as Array<{ pinned: boolean }>).map((e) => e.pinned),
    ).toEqual([false, false]);
    expect(before.pin).toBeNull();
    expect(before.environmentArgumentRequired).toBe(true);

    pin.set({ name: "a", source: "use_environment" });
    const after = await list({});
    expect(
      (after.environments as Array<{ pinned: boolean }>).map((e) => e.pinned),
    ).toEqual([true, false]);
    expect(after.pin).toEqual({ name: "a", source: "use_environment" });
    expect(after.environmentArgumentRequired).toBe(false);
  });
});
