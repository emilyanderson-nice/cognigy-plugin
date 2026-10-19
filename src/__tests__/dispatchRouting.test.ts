import { describe, it } from "@jest/globals";
import {
  EnvironmentError,
  createEnvironmentRegistry,
} from "../environments/registry.js";
import type { ProfileSet } from "../profiles/profiles.js";
import {
  KEY_A,
  KEY_B,
  KEY_BROKEN,
  allLogged,
  broken,
  harness,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));

/** The EnvironmentError the registry itself raises for this situation. */
function registryError(set: ProfileSet, name?: string): EnvironmentError {
  const reg = createEnvironmentRegistry({
    loadProfiles: () => set,
    createRuntime: (profile) => ({
      profile,
      client: {},
      handlers: { handleToolCall: async () => ({}) },
    }),
  });
  try {
    reg.resolve(name);
  } catch (e) {
    return e as EnvironmentError;
  }
  throw new Error("expected registry to throw");
}

describe("C1 list_environments", () => {
  it("C1: never resolves an environment; passes args without environment; returns JSON of the result", async () => {
    const h = harness({ set: TWO() });
    h.listEnvironments.mockResolvedValueOnce({ environments: [1], n: 2 });
    const r = await h.dispatcher.callTool("list_environments", {
      check: true,
      environment: "a",
    });
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ environments: [1], n: 2 }),
          },
        ],
      },
      "list_environments result",
      "C1: exact serialised result, no isError, no _environment",
      "Return the injected implementation's result as JSON text only.",
    );
    eq(
      h.listEnvironments.mock.calls,
      [[{ check: true }]],
      "list_environments args",
      "C1: called once with environment stripped",
      "Call the implementation once without the environment key.",
    );
    eq(
      [h.registry.resolve.mock.calls.length, h.rateLimiter.check.mock.calls],
      [0, [["__list_environments"]]],
      "list_environments isolation",
      "C1 (amended by F3): no resolve; exactly one rate-limit check keyed '__list_environments'",
      "Do not resolve an environment; rate limit this tool under its fixed key.",
    );
  });

  it("C1: undefined args are treated as an empty object", async () => {
    const h = harness({ set: setOf() });
    await h.dispatcher.callTool("list_environments", undefined);
    eq(
      h.listEnvironments.mock.calls,
      [[{}]],
      "list_environments undefined args",
      "C1: args default to {}",
      "Treat missing args as an empty object.",
    );
  });

  it("C1: works with zero configured environments", async () => {
    const h = harness({ set: setOf() });
    const r = await h.dispatcher.callTool("list_environments", {});
    ok(
      r.isError === undefined,
      "list_environments with none configured",
      "C1: never needs an environment",
      "success result",
      JSON.stringify(r),
      "Do not require any environment for list_environments.",
    );
  });

  it("C1: a throwing implementation becomes an isError { error } result", async () => {
    const h = harness({ set: TWO() });
    h.listEnvironments.mockRejectedValueOnce(new Error("kaboom"));
    const r = await h.dispatcher.callTool("list_environments", {});
    eq(
      r,
      {
        content: [{ type: "text", text: JSON.stringify({ error: "kaboom" }) }],
        isError: true,
      },
      "list_environments failure",
      "C1: errors are reported as isError results",
      "Catch the failure and return { error: message } with isError true.",
    );
  });
});

describe("C2 unknown tool", () => {
  it("C2: unknown tool name yields an isError result without touching registry or handlers", async () => {
    const h = harness({ set: TWO() });
    const r = await h.dispatcher.callTool("nope", { environment: "a" });
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Unknown tool: nope" }),
          },
        ],
        isError: true,
      },
      "unknown tool",
      "C2: exact error result",
      "Return { error: 'Unknown tool: <name>' } with isError true.",
    );
    eq(
      [h.registry.resolve.mock.calls.length, Object.keys(h.handlerCalls)],
      [0, []],
      "unknown tool side effects",
      "C2: registry not consulted, no handler built or run",
      "Reject unknown tools before any environment work.",
    );
  });
});

describe("C3 environment argument", () => {
  it("C3: strips environment before the handler sees args, without mutating the caller's object", async () => {
    const h = harness({ set: TWO() });
    const args = { environment: "b", x: "1", nested: { y: [1, 2] } };
    const before = JSON.stringify(args);
    await h.dispatcher.callTool("alpha", args);
    eq(
      h.handlerCalls["b"].mock.calls,
      [["alpha", { x: "1", nested: { y: [1, 2] } }]],
      "handler args",
      "C3: environment removed, everything else identical",
      "Pass every other argument through unchanged.",
    );
    ok(
      h.handlerCalls["b"].mock.calls[0][1] !== args,
      "handler args identity",
      "C3: handler receives a new object",
      "a different object",
      "same object",
      "Create a new args object rather than reusing the caller's.",
    );
    eq(
      JSON.stringify(args),
      before,
      "caller args",
      "C3: caller's object not mutated",
      "Do not delete keys from the caller's object.",
    );
  });

  it("C3: undefined args behave as {}", async () => {
    const h = harness({ set: setOf(usable("A", KEY_A)) });
    await h.dispatcher.callTool("alpha", undefined);
    eq(
      h.handlerCalls["a"].mock.calls,
      [["alpha", {}]],
      "undefined args",
      "C3: args undefined treated as {}",
      "Hand the handler an empty object.",
    );
  });

  it("C3: environment names are matched case/underscore-insensitively like the registry", async () => {
    const h = harness({ set: TWO() });
    await h.dispatcher.callTool("alpha", { environment: "  B " });
    eq(
      h.handlerCalls["b"]?.mock.calls.length,
      1,
      "padded name",
      "C3: resolves via the registry's normalisation",
      "Pass the supplied name to the registry rather than matching it yourself.",
    );
  });

  it.each([[42], [{ a: 1 }], [null], [true], [["a"]]])(
    "C3: a non-string environment (%j) is rejected naming the argument, no handler",
    async (bad) => {
      const h = harness({ set: TWO() });
      const r = await h.dispatcher.callTool("alpha", {
        environment: bad as unknown,
      });
      const body = parse(r);
      ok(
        r.isError === true &&
          typeof body.error === "string" &&
          /environment/.test(body.error as string),
        "non-string environment",
        "C3: environment must be a string when present",
        "isError result whose error names 'environment'",
        JSON.stringify(r),
        "Reject non-string environment values with a message naming the argument.",
      );
      eq(
        [Object.keys(h.handlerCalls), h.rateLimiter.check.mock.calls],
        [[], []],
        "non-string environment side effects",
        "C3: no handler, no rate limiting",
        "Validate before resolving or running anything.",
      );
      eq(
        [h.registry.resolve.mock.calls.length, body.code],
        [0, undefined],
        "non-string environment resolution",
        "F6: no registry resolution and never reported as ambiguous with 2+ configured",
        "Validate the argument type before consulting the registry.",
      );
    },
  );

  it.each([[""], ["   "], ["\t\n"]])(
    "C3: blank environment %j counts as not given (single env succeeds, multi is ambiguous)",
    async (blank) => {
      const one = harness({ set: setOf(usable("A", KEY_A)) });
      const r1 = await one.dispatcher.callTool("alpha", {
        environment: blank,
        x: "1",
      });
      ok(
        r1.isError === undefined &&
          JSON.stringify(one.handlerCalls["a"].mock.calls) ===
            JSON.stringify([["alpha", { x: "1" }]]),
        "blank environment, one configured",
        "C3: blank is treated as not given",
        "success on the only environment with environment stripped",
        JSON.stringify(r1),
        "Treat blank strings as absent.",
      );
      const two = harness({ set: TWO() });
      const r2 = await two.dispatcher.callTool("alpha", { environment: blank });
      eq(
        parse(r2).code,
        "ambiguous",
        "blank environment, two configured",
        "C3: blank is treated as not given",
        "Report ambiguity rather than an unknown environment.",
      );
    },
  );
});

describe("C4 resolution errors", () => {
  async function errorCase(set: ProfileSet, name: string | undefined) {
    const h = harness({ set });
    const args: Record<string, unknown> =
      name === undefined ? {} : { environment: name };
    const r = await h.dispatcher.callTool("alpha", args);
    const expectedErr = registryError(set, name);
    const expected: Record<string, unknown> = {
      error: expectedErr.message,
      code: expectedErr.code,
      ...(expectedErr.environment !== undefined
        ? { environment: expectedErr.environment }
        : {}),
      available: expectedErr.available,
    };
    eq(
      r,
      {
        content: [{ type: "text", text: JSON.stringify(expected) }],
        isError: true,
      },
      `resolution error ${expectedErr.code}`,
      "C4: exact { error, code, environment?, available } result, no _environment",
      "Report the registry's error message, code, requested name and available names.",
    );
    eq(
      [
        Object.keys(h.handlerCalls),
        h.rateLimiter.check.mock.calls,
        "_environment" in parse(r),
      ],
      [[], [], false],
      `resolution error ${expectedErr.code} side effects`,
      "C4: no handler, no rate limiter bucket, no _environment",
      "Stop before rate limiting and handler execution.",
    );
    return { r, h, expectedErr };
  }

  it("C4: unknown environment", async () => {
    const { expectedErr } = await errorCase(TWO(), "Nope");
    eq(
      expectedErr.code,
      "unknown",
      "fixture sanity",
      "C4: scenario is the unknown case",
      "n/a",
    );
  });

  it("C4: broken environment includes the reason", async () => {
    const { r, expectedErr } = await errorCase(
      setOf(usable("A", KEY_A), broken("B")),
      "b",
    );
    eq(
      expectedErr.code,
      "broken",
      "fixture sanity",
      "C4: scenario is the broken case",
      "n/a",
    );
    ok(
      (parse(r).error as string).includes("unusable"),
      "broken environment message",
      "C4: message carries the registry's reason",
      "message containing the registry reason text",
      String(parse(r).error),
      "Pass the registry's message through.",
    );
  });

  it("C4: none configured", async () => {
    const { expectedErr } = await errorCase(setOf(), undefined);
    eq(expectedErr.code, "none", "fixture sanity", "C4: none case", "n/a");
  });

  it("C4: ambiguous with two configured and no name, even when a default exists", async () => {
    const set = setOf(usable("A", KEY_A), usable("B", KEY_B), {
      COGNIGY_PROFILE: "a",
    });
    ok(
      set.defaultName === "a",
      "fixture sanity",
      "C4: a default exists",
      "defaultName a",
      String(set.defaultName),
      "n/a",
    );
    const { expectedErr } = await errorCase(set, undefined);
    eq(expectedErr.code, "ambiguous", "fixture sanity", "C4: ambiguous", "n/a");
  });

  it("C4: single environment, environment omitted: the call succeeds on it", async () => {
    const h = harness({ set: setOf(usable("A", KEY_A)) });
    const r = await h.dispatcher.callTool("alpha", { x: "1" });
    eq(
      [r.isError, parse(r)._environment],
      [undefined, { name: "a", host: "api-a.cognigy.ai" }],
      "single environment default",
      "C4: only environment is used when none is named",
      "Resolve to the only configured environment.",
    );
  });

  it("C4: a non-EnvironmentError from resolve becomes an isError { error: message }", async () => {
    const h = harness({ set: TWO() });
    h.registry.resolve.mockImplementationOnce(() => {
      throw new Error("registry exploded");
    });
    const r = await h.dispatcher.callTool("alpha", { environment: "a" });
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "registry exploded" }),
          },
        ],
        isError: true,
      },
      "unexpected resolve failure",
      "C4: other errors become { error } results",
      "Return the message as an isError result.",
    );
    eq(
      h.rateLimiter.check.mock.calls,
      [],
      "unexpected resolve failure side effects",
      "C4: rate limiter not consulted",
      "Do not rate limit when no environment resolved.",
    );
  });

  it("C4: error paths never log or return an API key", async () => {
    const h = harness({
      set: setOf(usable("A", KEY_A), usable("B", KEY_B), broken("C")),
    });
    const results = [
      await h.dispatcher.callTool("alpha", { environment: "c" }),
      await h.dispatcher.callTool("alpha", { environment: "zzz" }),
      await h.dispatcher.callTool("alpha", {}),
    ];
    const text = JSON.stringify(results) + allLogged(h);
    for (const k of [KEY_A, KEY_B, KEY_BROKEN])
      ok(
        !text.includes(k),
        "key leak on error paths",
        "C9: no API key in results or logs",
        "no key text anywhere",
        `contains ${k.slice(0, 13)}...`,
        "Never emit API keys.",
      );
  });
});
