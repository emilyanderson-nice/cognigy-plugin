/**
 * Module B: buildServerParts assembles settings + registry + dispatcher from
 * injected loaders/runtimes. Everything is driven through parts.dispatcher.
 */
import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { rig } from "./helpers/bootstrapRig.js";
import { tools } from "../tools/definitions.js";
import { ProfileConfigError } from "../profiles/profiles.js";
import { getTaskId } from "../utils/actorContext.js";
import {
  KEY_A,
  KEY_B,
  parse,
  setOf,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok, show } from "./helpers/specAssert.js";

const OPENAPI = "/openapi/openapi-viewer.json";
const TOOL = "list_resources";

const two = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const realNames = tools.map((t) => t.name);

// The real logger writes to console.error: keep a green run silent.
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("buildServerParts: tool surface", () => {
  it("lists every real tool plus list_environments and use_environment, each real tool gaining the environment enum", () => {
    const { parts } = rig(two());
    const listed = parts.dispatcher.listTools();
    eq(
      listed.map((t) => t.name).sort(),
      [
        ...realNames.filter(
          (n) => n !== "list_environments" && n !== "use_environment",
        ),
        "list_environments",
        "use_environment",
      ].sort(),
      "bootstrap::tool_names",
      "Rule: the dispatcher serves the real definitions plus list_environments and use_environment",
      "Serve exactly the exported tool definitions and add list_environments and use_environment.",
    );
    eq(
      listed.length,
      tools.length + 2,
      "bootstrap::tool_count",
      "Rule: final tool count is the real count plus two",
      "Add exactly two tools to the real definitions.",
    );
    for (const def of tools) {
      const t = listed.find((x) => x.name === def.name);
      const env = (t?.inputSchema.properties ?? {}).environment as
        | { type?: string; enum?: string[] }
        | undefined;
      eq(
        [env?.type, env?.enum],
        ["string", ["a", "b"]],
        `bootstrap::environment_property[${def.name}]`,
        "Rule: every real tool gets a string `environment` property enumerating a and b",
        "Inject the environment argument into every real tool.",
      );
      eq(
        t?.inputSchema.required,
        [
          ...((def.inputSchema.required as string[] | undefined) ?? []),
          "environment",
        ],
        `bootstrap::required_gains_environment[${def.name}]`,
        "Rule: with two environments `required` is the tool's original entries in order followed by `environment` exactly once",
        "Append `environment` last to each tool's required list, keeping the original entries.",
      );
    }
  });

  it("zero environments: tools still list, with no enum", () => {
    const { parts } = rig(setOf());
    const listed = parts.dispatcher.listTools();
    eq(
      listed.length,
      tools.length + 2,
      "bootstrap::zero_tool_count",
      "Rule: with no environments listTools still serves all tools",
      "Do not require credentials to list tools.",
    );
    const env = listed.find((t) => t.name === TOOL)?.inputSchema.properties
      ?.environment as Record<string, unknown>;
    ok(
      env && !("enum" in env),
      "bootstrap::zero_no_enum",
      "Rule: no enum when fewer than two environments exist",
      "environment property without enum",
      show(env),
      "Only enumerate names when more than one environment is configured.",
    );
    for (const def of tools.filter((d) => d.name !== "list_environments")) {
      eq(
        listed.find((t) => t.name === def.name)?.inputSchema.required,
        def.inputSchema.required,
        `bootstrap::zero_required_as_declared[${def.name}]`,
        "Rule: with fewer than two environments `required` is exactly as the tool declared it",
        "Do not add `environment` to required unless two or more environments exist.",
      );
    }
  });
});

describe("buildServerParts: settings and failure modes", () => {
  it("never requires credentials and exposes settings from the env", () => {
    const { parts } = rig(setOf(), {
      LOG_LEVEL: "debug",
      RATE_LIMIT_MAX_REQUESTS: "7",
    });
    eq(
      [parts.settings.logLevel, parts.settings.rateLimit.maxRequests],
      ["debug", 7],
      "bootstrap::settings",
      "Rule: settings = loadRuntimeSettings(env)",
      "Derive settings from the injected env, not process.env.",
    );
  });

  it("zero environments: list_environments is empty and a tool call returns the none error", async () => {
    const r = rig(setOf());
    const list = parse(await r.call("list_environments"));
    eq(
      [list.environments, list.configured],
      [[], 0],
      "bootstrap::zero_list",
      "Rule: empty list with configured 0",
      "Report no environments instead of failing.",
    );
    const res = await r.call(TOOL, {});
    const body = parse(res);
    ok(
      res.isError === true &&
        body.code === "none" &&
        String(body.error).includes("cognigy-setup profile add"),
      "bootstrap::zero_none_error",
      'Rule: no environment -> code "none" pointing at `cognigy-setup profile add`',
      'isError true, code "none", message naming cognigy-setup profile add',
      show(body),
      "Tell the user how to add an environment.",
    );
  });

  it("a throwing loader fails calls closed with code broken but keeps list_environments usable", async () => {
    const r = rig(two());
    r.throwOnLoad(new ProfileConfigError("config.json is not valid JSON"));
    const res = await r.call(TOOL, { environment: "a" });
    const body = parse(res);
    ok(
      res.isError === true && body.code === "broken",
      "bootstrap::broken_call",
      'Rule: loader failure -> calls fail closed with code "broken"',
      'isError true, code "broken"',
      show(body),
      "Never fall back to a guessed environment when configuration is unreadable.",
    );
    eq(
      r.createRuntime.mock.calls.length,
      0,
      "bootstrap::broken_no_runtime",
      "Rule: no runtime is built when configuration is broken",
      "Do not construct clients for unreadable config.",
    );
    const list = parse(await r.call("list_environments"));
    ok(
      typeof list.loadError === "string" &&
        list.loadError.includes("not valid JSON"),
      "bootstrap::broken_list",
      "Rule: list_environments stays usable and reports loadError",
      "loadError string present",
      show(list),
      "Surface the load problem through list_environments.",
    );
  });
});

describe("buildServerParts: routing and execution", () => {
  it("refuses a call without environment when two are configured", async () => {
    const r = rig(two());
    const res = await r.call(TOOL, {});
    eq(
      [res.isError, parse(res).code],
      [true, "ambiguous"],
      "bootstrap::ambiguous",
      "Rule: no guessing between two environments",
      "Require an explicit environment when more than one exists.",
    );
    eq(
      Object.keys(r.handlerCalls),
      [],
      "bootstrap::ambiguous_no_exec",
      "Rule: refused calls reach no handlers",
      "Do not execute anything when refusing.",
    );
  });

  it("a call with environment reaches that environment's handlers, strips the argument and marks the result", async () => {
    const r = rig(two());
    const res = await r.call(TOOL, { environment: "b", projectId: "p1" });
    const body = parse(res) as Record<string, any>;
    eq(
      r.handlerCalls.b.mock.calls,
      [[TOOL, { projectId: "p1" }]],
      "bootstrap::reaches_b",
      "Rule: handlers of the chosen environment get the tool args without `environment`",
      "Route to the selected runtime and remove the routing argument.",
    );
    eq(
      [r.handlerCalls.a, body._environment?.name, body.echo],
      [undefined, "b", { n: TOOL, a: { projectId: "p1" } }],
      "bootstrap::marker",
      "Rule: environment a untouched; result carries _environment name b",
      "Mark results with the environment that produced them.",
    );
  });

  it("each tool call runs inside its own task context", async () => {
    const seen: (string | undefined)[] = [];
    const r = rig(
      two(),
      {},
      {
        a: async () => {
          seen.push(getTaskId());
          return { ok: true };
        },
      },
    );
    await r.call(TOOL, { environment: "a" });
    await r.call(TOOL, { environment: "a" });
    ok(
      typeof seen[0] === "string" &&
        typeof seen[1] === "string" &&
        seen[0] !== seen[1],
      "bootstrap::task_context",
      "Rule: runWithTask wraps every environment call (one task id per call)",
      "two different string task ids seen inside the handler",
      show(seen),
      "Run each tool call in a fresh task context so audit events group per call.",
    );
  });

  it("logs the received tool call through the real logger", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = rig(two());
    await r.call(TOOL, { environment: "a" });
    ok(
      JSON.stringify(spy.mock.calls).includes(`Tool call received: ${TOOL}`),
      "bootstrap::logger",
      "Rule: dispatcher logs through the real logger",
      "a 'Tool call received' line on stderr",
      show(spy.mock.calls),
      "Wire the real logger into the dispatcher.",
    );
  });

  it("rate limits per environment from settings.rateLimit", async () => {
    const r = rig(two(), { RATE_LIMIT_MAX_REQUESTS: "2" });
    const ok1 = await r.call(TOOL, { environment: "a" });
    const ok2 = await r.call(TOOL, { environment: "a" });
    const denied = await r.call(TOOL, { environment: "a" });
    const other = await r.call(TOOL, { environment: "b" });
    eq(
      [
        parse(ok1).error,
        parse(ok2).error,
        parse(denied).error,
        parse(other).error,
      ],
      [undefined, undefined, "Rate limit exceeded", undefined],
      "bootstrap::rate_limit",
      "Rule: limit applies per environment name; 3rd call on a is denied, b is not",
      "Build the limiter from settings and key it by environment name.",
    );
    eq(
      r.handlerCalls.a.mock.calls.length,
      2,
      "bootstrap::rate_limit_exec",
      "Rule: the denied call never reaches the handlers",
      "Check the limit before executing.",
    );
  });
});

describe("buildServerParts: list_environments", () => {
  it("returns both environments, never any key", async () => {
    const r = rig(two());
    const res = await r.call("list_environments");
    const body = parse(res) as Record<string, any>;
    eq(
      [
        body.environments.map((e: { name: string }) => e.name),
        body.configured,
        body.environmentArgumentRequired,
      ],
      [["a", "b"], 2, true],
      "bootstrap::list_two",
      "Rule: both environments listed, argument required",
      "List every configured environment.",
    );
    const text = res.content[0].text;
    ok(
      !text.includes(KEY_A) && !text.includes(KEY_B),
      "bootstrap::list_no_keys",
      "Rule: list_environments never exposes API keys",
      "no key text",
      "key text present",
      "Return only hosts and names.",
    );
  });

  it("check:true probes each environment's own client, memoised per runtime", async () => {
    const r = rig(two());
    const first = parse(
      await r.call("list_environments", { check: true }),
    ) as Record<string, any>;
    await r.call("list_environments", { check: true });
    eq(
      [r.gets.a.length, r.gets.b.length],
      [1, 1],
      "bootstrap::one_runtime_each",
      "Rule: one runtime per environment is reused",
      "Resolve runtimes through the registry cache.",
    );
    eq(
      [r.gets.a[0].mock.calls, r.gets.b[0].mock.calls],
      [[[OPENAPI]], [[OPENAPI]]],
      "bootstrap::detect_once",
      "Rule: each environment's client is probed once across two checks (memoised)",
      "Memoise release detection per runtime.",
    );
    eq(
      first.environments.map((e: { release?: string }) => e.release),
      ["2026.21.0", "2026.21.0"],
      "bootstrap::detected_release",
      "Rule: detected release reported",
      "Report the release from the probe result.",
    );
  });

  it("a runtime rebuilt after a profile edit gets a fresh detector", async () => {
    const r = rig(two());
    await r.call("list_environments", { check: true });
    const edited = setOf(usable("A", KEY_A + "-rotated"), usable("B", KEY_B));
    r.set(edited);
    await r.call("list_environments", { check: true });
    eq(
      [
        r.gets.a.length,
        r.gets.a[0].mock.calls.length,
        r.gets.a[1]?.mock.calls.length,
      ],
      [2, 1, 1],
      "bootstrap::fresh_detector",
      "Rule: edited profile -> new runtime -> new detector probes the new client",
      "Key detectors to the runtime, not the environment name.",
    );
    eq(
      [r.gets.b.length, r.gets.b[0].mock.calls.length],
      [1, 1],
      "bootstrap::unedited_memoised",
      "Rule: the unedited environment keeps its memoised detection",
      "Only rebuild what changed.",
    );
  });
});
