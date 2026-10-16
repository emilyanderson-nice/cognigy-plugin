import { describe, it } from "@jest/globals";
import type { ToolDefinition } from "../server/dispatch.js";
import {
  LIST_ENV_TOOL,
  harness,
  KEY_A,
  KEY_B,
  parse,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const ONE = () => setOf(usable("A", KEY_A));
const FIVE = ["t1", "t2", "t3", "t4", "t5"].map((n) => tool(n));

describe("F2 listTools takes one snapshot", () => {
  it("F2: exactly one registry snapshot and one profile load per listTools() call, with a 5-tool list", () => {
    const h = harness({ set: TWO(), tools: FIVE });
    h.dispatcher.listTools();
    eq(
      [h.registry.snapshot.mock.calls.length, h.loadCount()],
      [1, 1],
      "first listTools snapshot count",
      "F2: one snapshot and one load per call",
      "Read the environment list once per listTools call, not once per tool.",
    );
    h.dispatcher.listTools();
    eq(
      [h.registry.snapshot.mock.calls.length, h.loadCount()],
      [2, 2],
      "second listTools snapshot count",
      "F2: still one per call",
      "Re-read once on every call.",
    );
  });

  it("F2: every tool in one response shows the same enum", () => {
    const h = harness({ set: TWO(), tools: FIVE });
    const enums = h.dispatcher
      .listTools()
      .filter((t) => t.name !== "list_environments")
      .map((t) =>
        JSON.stringify(
          (t.inputSchema.properties as Record<string, { enum?: string[] }>)
            .environment.enum,
        ),
      );
    eq(
      enums,
      Array(5).fill(JSON.stringify(["a", "b"])),
      "enum consistency",
      "F2: identical enum on all tools",
      "Compute the enum once and share its values.",
    );
  });

  it("F2: the returned list_environments definition is a clone; mutating it affects nothing later", () => {
    const h = harness({ set: ONE(), tools: FIVE });
    const pristine = JSON.stringify(LIST_ENV_TOOL);
    const first = h.dispatcher.listTools();
    const le = first[first.length - 1] as ToolDefinition;
    ok(
      le !== LIST_ENV_TOOL && le.inputSchema !== LIST_ENV_TOOL.inputSchema,
      "list_environments clone",
      "F2: returned definition is not the injected reference",
      "a new object with a new inputSchema",
      "same reference",
      "Return a copy of the injected definition.",
    );
    le.description = "TAMPERED";
    (le.inputSchema.properties as Record<string, unknown>).injected = true;
    const second = h.dispatcher.listTools();
    eq(
      JSON.stringify(second[second.length - 1]),
      pristine,
      "later list_environments definition",
      "F2: mutation of a returned tool never leaks",
      "Hand out a fresh copy on every call.",
    );
    eq(
      JSON.stringify(LIST_ENV_TOOL),
      pristine,
      "injected definition",
      "F2: deps.listEnvironmentsTool never mutated",
      "Never change the supplied definition.",
    );
  });
});

describe("F3 list_environments is rate limited", () => {
  it("F3: one check with the fixed key before deps.listEnvironments runs", async () => {
    const order: string[] = [];
    const h = harness({ set: TWO() });
    h.rateLimiter.check.mockImplementation((k) => {
      order.push(`check:${k}`);
      return true;
    });
    h.listEnvironments.mockImplementation(async () => {
      order.push("list");
      return { environments: [] };
    });
    await h.dispatcher.callTool("list_environments", {});
    eq(
      order,
      ["check:__list_environments", "list"],
      "list_environments limiter order",
      "F3: exactly one check, keyed '__list_environments', before the implementation",
      "Rate limit list_environments under its own fixed key before running it.",
    );
  });

  it("F3: when denied returns { error: 'Rate limit exceeded' } without isError or _environment and skips the implementation", async () => {
    const h = harness({ set: TWO() });
    h.rateLimiter.check.mockReturnValue(false);
    const r = await h.dispatcher.callTool("list_environments", {});
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Rate limit exceeded" }),
          },
        ],
      },
      "list_environments rate limited",
      "F3: same non-error shape as other rate limits, no _environment",
      "Return the plain rate-limit payload without isError.",
    );
    eq(
      h.listEnvironments.mock.calls.length,
      0,
      "list_environments denied call",
      "F3: injected implementation not called",
      "Skip the implementation when denied.",
    );
  });
});

describe("F6 environment argument and own __proto__", () => {
  it.each([[42], [true], [false], [["a"]], [{ n: "a" }], [null]])(
    "F6: present non-string environment %j is rejected as such, even with 2+ configured",
    async (bad) => {
      const h = harness({ set: TWO() });
      const r = await h.dispatcher.callTool("alpha", {
        environment: bad as unknown,
      });
      const body = parse(r);
      ok(
        r.isError === true &&
          /environment/.test(String(body.error)) &&
          body.code !== "ambiguous" &&
          !("_environment" in body),
        "non-string environment",
        "F6: error mentions 'environment', is not 'ambiguous', no _environment",
        "isError result about the environment argument's type",
        JSON.stringify(r),
        "Validate the argument type first and say what is wrong.",
      );
      eq(
        [
          h.registry.resolve.mock.calls.length,
          h.rateLimiter.check.mock.calls.length,
          Object.keys(h.handlerCalls).length,
        ],
        [0, 0, 0],
        "non-string environment side effects",
        "F6: no resolve, no limiter, no handler",
        "Stop before any environment work.",
      );
    },
  );

  it("F6: environment undefined counts as not provided", async () => {
    const h = harness({ set: ONE() });
    const r = await h.dispatcher.callTool("alpha", {
      environment: undefined,
      x: "1",
    });
    eq(
      [r.isError, h.handlerCalls["a"].mock.calls],
      [undefined, [["alpha", { x: "1" }]]],
      "undefined environment",
      "F6: undefined equals not provided",
      "Treat undefined like an omitted argument.",
    );
  });

  it("F6: an own __proto__ key reaches the handler as plain own data without changing the prototype", async () => {
    const h = harness({ set: ONE() });
    const args = JSON.parse('{"__proto__":{"polluted":true},"x":1}') as Record<
      string,
      unknown
    >;
    await h.dispatcher.callTool("alpha", args);
    const received = h.handlerCalls["a"].mock.calls[0][1];
    ok(
      Object.getPrototypeOf(received) === Object.prototype &&
        Object.prototype.hasOwnProperty.call(received, "__proto__") &&
        Object.getOwnPropertyDescriptor(received, "__proto__")?.value !==
          undefined &&
        JSON.stringify(
          Object.getOwnPropertyDescriptor(received, "__proto__")?.value,
        ) === '{"polluted":true}' &&
        (received as { polluted?: unknown }).polluted === undefined &&
        ({} as { polluted?: unknown }).polluted === undefined,
      "__proto__ forwarding",
      "F6: own __proto__ forwarded as data, no prototype pollution",
      "plain-prototype object with own data key __proto__ = {polluted:true}",
      JSON.stringify(Object.getOwnPropertyNames(received)),
      "Copy arguments so that __proto__ stays an ordinary own property.",
    );
    eq(
      received.x,
      1,
      "other keys",
      "F6: remaining keys intact",
      "Forward all other arguments.",
    );
  });
});
