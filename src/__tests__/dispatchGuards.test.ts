import { describe, it } from "@jest/globals";
import {
  KEY_A,
  KEY_B,
  LIST_ENV_TOOL,
  harness,
  parse,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const TALK = [tool("alpha"), tool("talk_to_agent")];

describe("C8 talk_to_agent host guard", () => {
  it("C8: a matching host (case-insensitive) passes through to the handler UNCHANGED", async () => {
    const h = harness({ set: TWO(), tools: TALK });
    const u = "https://ENDPOINT-A.cognigy.ai/path/to/x?token=abc&y=1#frag";
    const r = await h.dispatcher.callTool("talk_to_agent", {
      environment: "a",
      endpointUrl: u,
      message: "hi",
    });
    eq(
      h.handlerCalls["a"]?.mock.calls,
      [["talk_to_agent", { endpointUrl: u, message: "hi" }]],
      "matching endpoint host",
      "C8: URL passed through untouched",
      "Do not rewrite or normalise the supplied endpointUrl.",
    );
    ok(
      r.isError === undefined,
      "matching endpoint host result",
      "C8: success",
      "no isError",
      JSON.stringify(r),
      "Allow endpoint URLs on the environment's own endpoint host.",
    );
  });

  it("C8: a different host is rejected naming both hosts and the environment, handler not called", async () => {
    const h = harness({ set: TWO(), tools: TALK });
    const r = await h.dispatcher.callTool("talk_to_agent", {
      environment: "a",
      endpointUrl: "https://endpoint-b.cognigy.ai/abc/token",
    });
    const body = parse(r);
    const text = String(body.error);
    ok(
      r.isError === true &&
        text.includes("endpoint-b.cognigy.ai") &&
        text.includes("endpoint-a.cognigy.ai") &&
        /\ba\b/.test(text),
      "mismatched endpoint host",
      "C8: error names the URL host, the environment endpoint host and the environment",
      "isError whose message includes endpoint-b.cognigy.ai, endpoint-a.cognigy.ai and 'a'",
      JSON.stringify(r),
      "Explain which host was supplied, which one the environment uses, and which environment.",
    );
    eq(
      body._environment,
      { name: "a", host: "api-a.cognigy.ai" },
      "mismatch _environment",
      "C8: _environment attached",
      "Attach the environment to the rejection.",
    );
    ok(
      !text.includes("/abc/token") && !text.includes("https://"),
      "mismatch message hygiene",
      "C8: only hosts are echoed, not the URL path",
      "no path or scheme in the message",
      text,
      "Do not echo the full URL.",
    );
    eq(
      h.handlerCalls["a"]?.mock.calls.length ?? 0,
      0,
      "mismatch handler",
      "C8: handler not called",
      "Block the call before it reaches the handler.",
    );
  });

  it("C8: host comparison includes the port", async () => {
    const set = setOf({
      COGNIGY_PROFILE_A_API_BASE_URL: "https://api-a.cognigy.ai",
      COGNIGY_PROFILE_A_API_KEY: KEY_A,
      COGNIGY_PROFILE_A_ENDPOINT_BASE_URL: "https://ep.example.com:8443",
    });
    const h = harness({ set, tools: TALK });
    const okR = await h.dispatcher.callTool("talk_to_agent", {
      endpointUrl: "https://ep.example.com:8443/t",
    });
    const badR = await h.dispatcher.callTool("talk_to_agent", {
      endpointUrl: "https://ep.example.com:9999/t",
    });
    eq(
      [okR.isError, badR.isError, h.handlerCalls["a"].mock.calls.length],
      [undefined, true, 1],
      "port comparison",
      "C8: same hostname with a different port is a different host",
      "Compare hostname and port together.",
    );
  });

  it.each([
    ["number", 42],
    ["empty string", ""],
    ["undefined", undefined],
    ["object", { u: 1 }],
  ])(
    "C8: endpointUrl (%s) is passed through untouched with no check",
    async (_n, value) => {
      const h = harness({ set: TWO(), tools: TALK });
      const args: Record<string, unknown> = { environment: "a", m: 1 };
      if (value !== undefined) args.endpointUrl = value;
      const r = await h.dispatcher.callTool("talk_to_agent", args);
      const { environment: _e, ...rest } = args;
      void _e;
      eq(
        [r.isError, h.handlerCalls["a"]?.mock.calls],
        [undefined, [["talk_to_agent", rest]]],
        `endpointUrl ${_n}`,
        "C8: values that are not absolute http(s) URLs are not guarded",
        "Only validate string values that parse as absolute http(s) URLs.",
      );
    },
  );

  it("C8: other tools are never subject to the check", async () => {
    const h = harness({ set: TWO(), tools: TALK });
    const args = {
      environment: "a",
      endpointUrl: "https://elsewhere.example/x",
    };
    const r = await h.dispatcher.callTool("alpha", args);
    eq(
      [r.isError, h.handlerCalls["a"]?.mock.calls],
      [undefined, [["alpha", { endpointUrl: "https://elsewhere.example/x" }]]],
      "non-talk tool endpointUrl",
      "C8: guard applies only to talk_to_agent",
      "Leave other tools' arguments alone.",
    );
  });
});

describe("C10 concurrency", () => {
  it("C10: overlapping calls reach their own handlers and carry their own _environment", async () => {
    let releaseA!: (v: unknown) => void;
    let releaseB!: (v: unknown) => void;
    const h = harness({
      set: TWO(),
      impl: {
        a: () => new Promise((res) => (releaseA = res)),
        b: () => new Promise((res) => (releaseB = res)),
      },
    });
    const pa = h.dispatcher.callTool("alpha", { environment: "a", n: 1 });
    const pb = h.dispatcher.callTool("alpha", { environment: "b", n: 2 });
    await new Promise((r) => setTimeout(r, 0));
    ok(
      typeof releaseA === "function" && typeof releaseB === "function",
      "overlap",
      "C10: both handlers are in flight at once",
      "both handlers started before either finished",
      `a started=${typeof releaseA}, b started=${typeof releaseB}`,
      "Do not serialise calls across environments.",
    );
    releaseB({ who: "b-result" });
    releaseA({ who: "a-result" });
    const [ra, rb] = await Promise.all([pa, pb]);
    eq(
      [parse(ra), parse(rb)],
      [
        {
          who: "a-result",
          _environment: { name: "a", host: "api-a.cognigy.ai" },
        },
        {
          who: "b-result",
          _environment: { name: "b", host: "api-b.cognigy.ai" },
        },
      ],
      "overlapping outputs",
      "C10: outputs matched to the right environment",
      "Keep per-call state local to each call.",
    );
    eq(
      [
        h.handlerCalls["a"].mock.calls[0][1],
        h.handlerCalls["b"].mock.calls[0][1],
      ],
      [{ n: 1 }, { n: 2 }],
      "overlapping args",
      "C10: each handler got its own arguments",
      "Never share argument state across calls.",
    );
  });
});

describe("C11 backward compatibility with one environment", () => {
  const results: Record<string, unknown> = {
    plain: { id: "1", items: [1, 2] },
    hinted: { ok: true, _hints: { warning: "w" } },
    list: [1, 2, 3],
    text: "hello",
    empty: {},
  };
  const tools = Object.keys(results).map((n) => tool(n));

  it.each(Object.keys(results))(
    "C11: %s call without environment returns exactly handler result plus _environment",
    async (name) => {
      const h = harness({
        set: setOf(usable("A", KEY_A)),
        tools,
        impl: { a: async () => results[name] },
      });
      const r = await h.dispatcher.callTool(name, { x: "1" });
      const value = results[name];
      const expected =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? {
              ...(value as object),
              _environment: { name: "a", host: "api-a.cognigy.ai" },
            }
          : {
              result: value,
              _environment: { name: "a", host: "api-a.cognigy.ai" },
            };
      eq(
        r,
        { content: [{ type: "text", text: JSON.stringify(expected) }] },
        `golden ${name}`,
        "C11: legacy output plus only _environment",
        "Do not add or alter anything else in single-environment results.",
      );
      eq(
        h.handlerCalls["a"].mock.calls,
        [[name, { x: "1" }]],
        `golden ${name} args`,
        "C11: handler args identical to the caller's",
        "Pass arguments through unchanged.",
      );
    },
  );

  it("C11: listTools equals input plus environment property plus list_environments, nothing else", () => {
    const input = [
      tool("alpha", {
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        annotations: { readOnlyHint: true },
      }),
      tool("beta", { inputSchema: { type: "object" } }),
    ];
    const h = harness({ set: setOf(usable("A", KEY_A)), tools: input });
    const out = h.dispatcher.listTools();
    const stripped = out
      .filter((t) => t.name !== "list_environments")
      .map((t) => {
        const props = {
          ...(t.inputSchema.properties as Record<string, unknown>),
        };
        delete props.environment;
        const schema = { ...t.inputSchema, properties: props };
        return { ...t, inputSchema: schema };
      });
    eq(
      stripped,
      [
        { ...input[0], inputSchema: { ...input[0].inputSchema } },
        {
          ...input[1],
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "golden listTools",
      "C11: definitions unchanged apart from the environment property",
      "Change nothing else in existing tool definitions.",
    );
    eq(
      out[out.length - 1],
      LIST_ENV_TOOL,
      "golden list_environments",
      "C11: list_environments appended",
      "Append list_environments.",
    );
    eq(
      out.length,
      3,
      "golden listTools length",
      "C11: nothing else added",
      "Add only list_environments.",
    );
  });
});
