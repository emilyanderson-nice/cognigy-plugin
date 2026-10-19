import { describe, it } from "@jest/globals";
import {
  KEY_A,
  allLogged,
  harness,
  parse,
  setOf,
  tool,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const HOST = "endpoint-a.example.test";
const TOOLS = [tool("alpha"), tool("talk_to_agent")];
const mkSet = () =>
  setOf({
    COGNIGY_PROFILE_A_API_BASE_URL: "https://api-a.example.test",
    COGNIGY_PROFILE_A_API_KEY: KEY_A,
    COGNIGY_PROFILE_A_ENDPOINT_BASE_URL: `https://${HOST}`,
  });
const talk = (endpointUrl: unknown) => {
  const h = harness({ set: mkSet(), tools: TOOLS });
  return {
    h,
    run: () => h.dispatcher.callTool("talk_to_agent", { endpointUrl }),
  };
};
const handlerCount = (h: ReturnType<typeof harness>): number =>
  h.handlerCalls["a"]?.mock.calls.length ?? 0;

const NON_URLS = [
  "evil.com",
  "//evil.com/x",
  "xn--a.b/x",
  "javascript:alert(1)",
  "ftp://h/x",
  "not a url",
  " ",
];

const BYPASS = [
  "https://endpoint-a.example.test@evil.test/x",
  "https://endpoint-a.example.test\\@evil.test/x",
  "https://evil.test#@endpoint-a.example.test/x",
  "https://evil.test/?h=endpoint-a.example.test",
  "https:evil.test",
  " https://evil.test/x",
  "https://endpoint-a.example.test.evil.test/x",
  "https://endpoint-a.example.test.:9999/x",
  "https://[::1]/x",
  "https://evil.test%2eexample.test/x",
];

const PASS = [
  "https://endpoint-a.example.test/x?y=1#z",
  "HTTPS://ENDPOINT-A.EXAMPLE.TEST/x",
  "https://endpoint-a.example.test:443/x",
];

describe("F4 host guard fails closed", () => {
  it.each(NON_URLS)(
    "F4: non-URL endpointUrl %j is rejected, naming the argument and environment, without echoing it",
    async (value) => {
      const { h, run } = talk(value);
      const r = await run();
      const body = parse(r);
      const text = String(body.error);
      ok(
        r.isError === true &&
          text.includes("endpointUrl") &&
          /\ba\b/.test(text) &&
          (value.trim() === "" || !text.includes(value)),
        `non-URL endpointUrl ${JSON.stringify(value)}`,
        "F4: fail closed, message names endpointUrl and the environment, never the value",
        "isError result mentioning endpointUrl and environment 'a' without the supplied value",
        JSON.stringify(r),
        "Reject unparseable endpoint URLs instead of passing them on.",
      );
      eq(
        [body._environment, handlerCount(h)],
        [{ name: "a", host: "api-a.example.test" }, 0],
        `non-URL endpointUrl ${JSON.stringify(value)} effects`,
        "F4: _environment attached, handler not called",
        "Attach the environment and skip the handler.",
      );
    },
  );

  it.each([
    ["empty string", ""],
    ["number", 7],
    ["undefined", undefined],
    ["null", null],
    ["object", { u: 1 }],
  ])(
    "F4: endpointUrl (%s) still counts as not provided and passes through untouched",
    async (_n, value) => {
      const { h, run } = talk(value);
      const r = await run();
      eq(
        [r.isError, h.handlerCalls["a"]?.mock.calls],
        [undefined, [["talk_to_agent", { endpointUrl: value }]]],
        `endpointUrl ${_n}`,
        "F4: empty and non-string values are not guarded",
        "Only non-empty strings are validated.",
      );
    },
  );

  it("F4: an unparseable endpointBaseUrl on the profile yields an isError result, not an exception", async () => {
    const set = mkSet();
    set.profiles[0].endpointBaseUrl = "not a url at all";
    const h = harness({ set, tools: TOOLS });
    const r = await h.dispatcher.callTool("talk_to_agent", {
      endpointUrl: "https://x.test/y",
    });
    const body = parse(r);
    ok(
      r.isError === true &&
        typeof body.error === "string" &&
        !String(body.error).includes("not a url at all") &&
        (body._environment as { name?: string })?.name === "a",
      "unparseable endpointBaseUrl",
      "F4: fixed-text error with _environment, no exception",
      "isError result with _environment and no echo of the stored value",
      JSON.stringify(r),
      "Return an error result when the environment's endpoint host cannot be determined.",
    );
    eq(
      handlerCount(h),
      0,
      "unparseable endpointBaseUrl handler",
      "F4: handler not called",
      "Do not run the tool.",
    );
  });

  it.each(BYPASS)("F4 bypass table: %j is rejected", async (value) => {
    const { h, run } = talk(value);
    const r = await run();
    ok(
      r.isError === true && handlerCount(h) === 0,
      `bypass ${JSON.stringify(value)}`,
      "F4: URL does not unambiguously target the environment's endpoint host",
      "isError result and no handler call",
      `isError=${String(r.isError)}, handler calls=${handlerCount(h)}`,
      "Reject anything whose real host, port or form differs from the environment's endpoint.",
    );
  });

  it.each(PASS)(
    "F4 bypass table: %j passes through UNCHANGED",
    async (value) => {
      const { h, run } = talk(value);
      const r = await run();
      eq(
        [r.isError, h.handlerCalls["a"]?.mock.calls],
        [undefined, [["talk_to_agent", { endpointUrl: value }]]],
        `legit ${JSON.stringify(value)}`,
        "F4: same-host URLs reach the handler byte-for-byte",
        "Allow URLs on the environment's endpoint host without rewriting.",
      );
    },
  );

  it.each([...NON_URLS, ...BYPASS])(
    "F4: rejection of %j logs exactly one warn without the URL value or any key",
    async (value) => {
      const { h, run } = talk(value);
      await run();
      eq(
        h.logger.warn.mock.calls.length,
        1,
        `warn count ${JSON.stringify(value)}`,
        "F4: one warn line per guard rejection",
        "Log one warning when the guard rejects a call.",
      );
      const logged = allLogged(h);
      ok(
        !logged.includes(KEY_A) &&
          (value.trim().length < 3 ||
            (!logged.includes(value) &&
              !logged.includes(JSON.stringify(value).slice(1, -1)))),
        `warn content ${JSON.stringify(value)}`,
        "F4: no URL value or key in logs",
        "log text without the supplied URL or any API key",
        logged,
        "Log only the environment and tool names.",
      );
    },
  );

  it("F4: a passing call logs no warn", async () => {
    const { h, run } = talk(PASS[0]);
    await run();
    eq(
      h.logger.warn.mock.calls.length,
      0,
      "warn on success",
      "F4: warn only on rejection",
      "Do not warn for allowed calls.",
    );
  });
});

describe("G4 host mismatch remedy", () => {
  it.each([
    "https://evil.test/secret/path?q=1",
    "https://endpoint-a.example.test.evil.test/secret/path",
  ])(
    "clean different-host URL %j names both override mechanisms, both hosts and the environment, never the path",
    async (value) => {
      const { h, run } = talk(value);
      const r = await run();
      const body = parse(r);
      const error = String(body.error);
      const urlHost = new URL(value).host;
      ok(
        r.isError === true &&
          error.includes("COGNIGY_ENDPOINT_BASE_URL") &&
          error.includes("endpointBaseUrl") &&
          error.includes(HOST) &&
          error.includes(urlHost) &&
          error.includes('"a"') &&
          !error.includes("secret") &&
          !error.includes("q=1"),
        `host mismatch remedy ${value}`,
        "G4: the mismatch error names COGNIGY_ENDPOINT_BASE_URL and endpointBaseUrl, both hosts and the environment; no path",
        "isError message with all of those and no path text",
        JSON.stringify(body),
        "Tell the user both ways to declare a custom endpoint host.",
      );
      eq(
        handlerCount(h),
        0,
        `host mismatch handler ${value}`,
        "G4: still not executed",
        "Keep refusing the call.",
      );
    },
  );

  // [vector, character the vector must really contain ("" = no requirement)]
  it.each([
    ...NON_URLS.map((v) => [v, ""] as const),
    ["https://endpoint-a.example.test@evil.test/x", "@"],
    ["https://endpoint-a.example.test\\@evil.test/x", "\\"],
    ["https://endpoint-a.example.test/x\u0007y", "\u0007"],
  ] as const)(
    "generic rejection of %j does not carry the override remedy",
    async (value, mustHave) => {
      ok(
        value.includes(mustHave),
        `vector sanity ${JSON.stringify(value)}`,
        "G4: each vector really contains the character it is meant to exercise",
        `vector containing ${JSON.stringify(mustHave)}`,
        JSON.stringify(value),
        "Escape backslashes and keep control characters in the literal.",
      );
      const { run } = talk(value);
      const error = String(parse(await run()).error);
      ok(
        !error.includes("COGNIGY_ENDPOINT_BASE_URL") &&
          !error.includes("endpointBaseUrl"),
        `generic rejection ${JSON.stringify(value)}`,
        "G4: unparseable/credential/backslash/control-character rejections stay generic",
        "no override remedy text",
        error,
        "Only the clean different-host case suggests overriding the endpoint host.",
      );
    },
  );
});
