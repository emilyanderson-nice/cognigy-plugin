import { describe, it } from "@jest/globals";
import {
  KEY_A,
  KEY_B,
  allLogged,
  harness,
  parse,
  setOf,
  usable,
  type HandlerImpl,
} from "./helpers/dispatchHarness.js";
import { eq, ok } from "./helpers/specAssert.js";

const ENV_A = { name: "a", host: "api-a.cognigy.ai" };
const ENV_B = { name: "b", host: "api-b.cognigy.ai" };
const ONE = () => setOf(usable("A", KEY_A));
const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));

const returning = (value: unknown): Record<string, HandlerImpl> => ({
  a: async () => value,
});

describe("C5 success path", () => {
  it("C5: runs the handler inside runWithTask exactly once per call and serialises output plus _environment", async () => {
    let inside = false;
    const h = harness({
      set: ONE(),
      impl: {
        a: async () => {
          eq(
            inside,
            true,
            "handler context",
            "C5: handler executes inside runWithTask",
            "Run the handler within the per-call context wrapper.",
          );
          return { data: [1, 2], count: 2 };
        },
      },
    });
    h.runWithTask.mockImplementation(async (fn) => {
      inside = true;
      try {
        return await fn();
      } finally {
        inside = false;
      }
    });
    const r = await h.dispatcher.callTool("alpha", {});
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [1, 2],
              count: 2,
              _environment: ENV_A,
            }),
          },
        ],
      },
      "success result",
      "C5: exact JSON with trailing _environment and no isError",
      "Return the handler keys plus _environment { name, host }.",
    );
    eq(
      h.runWithTask.mock.calls.length,
      1,
      "runWithTask count",
      "C5: wrapper used once per call",
      "Wrap each call exactly once.",
    );
  });

  it("C5: _environment is a sibling of _hints; existing _hints untouched", async () => {
    const hints = { warning: "w", action: "act" };
    const h = harness({
      set: ONE(),
      impl: returning({ ok: true, _hints: hints }),
    });
    const body = parse(await h.dispatcher.callTool("alpha", {}));
    eq(
      body,
      { ok: true, _hints: hints, _environment: ENV_A },
      "hints preserved",
      "C5: _hints unchanged and _environment top-level",
      "Do not nest _environment in _hints or alter hints.",
    );
  });

  it.each([
    ["array", [1, "two"]],
    ["string", "plain"],
    ["number", 7],
    ["null", null],
  ])(
    "C5: non-object result (%s) is wrapped as { result, _environment }",
    async (_n, value) => {
      const h = harness({ set: ONE(), impl: returning(value) });
      const r = await h.dispatcher.callTool("alpha", {});
      eq(
        JSON.parse(r.content[0].text),
        { result: value, _environment: ENV_A },
        `non-object result ${_n}`,
        "C5: non-plain-object output is wrapped",
        "Wrap non-object results under a result key.",
      );
      ok(
        r.isError === undefined,
        `non-object result ${_n} flag`,
        "C5: no isError",
        "no isError",
        String(r.isError),
        "Success results carry no isError.",
      );
    },
  );

  it("C5: the dispatcher's _environment wins over one in the handler result", async () => {
    const h = harness({
      set: ONE(),
      impl: returning({ _environment: { name: "evil", host: "evil.example" } }),
    });
    eq(
      parse(await h.dispatcher.callTool("alpha", {})),
      { _environment: ENV_A },
      "_environment collision",
      "C5: dispatcher value wins",
      "Overwrite any handler-supplied _environment.",
    );
  });

  it("C5: _environment holds only name and host, never a key or URL path", async () => {
    const h = harness({ set: ONE() });
    const text = (await h.dispatcher.callTool("alpha", {})).content[0].text;
    eq(
      Object.keys(
        parse({ content: [{ type: "text", text }] })._environment as object,
      ),
      ["name", "host"],
      "_environment keys",
      "C5: exactly name and host",
      "Expose only the profile name and API host.",
    );
    ok(
      !text.includes(KEY_A) && !text.includes("https://"),
      "_environment content",
      "C5: no key, no full URL",
      "no key and no scheme",
      text,
      "Never include credentials or full URLs.",
    );
  });
});

describe("C6 handler errors", () => {
  it("C6: thrown error becomes isError JSON with status/code/traceId and _environment", async () => {
    const err = Object.assign(new Error("boom"), {
      status: 404,
      code: "NOT_FOUND",
      traceId: "t-1",
    });
    const h = harness({
      set: ONE(),
      impl: {
        a: async () => {
          throw err;
        },
      },
    });
    eq(
      await h.dispatcher.callTool("alpha", {}),
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "boom",
              status: 404,
              code: "NOT_FOUND",
              traceId: "t-1",
              _environment: ENV_A,
            }),
          },
        ],
        isError: true,
      },
      "handler error",
      "C6: exact error payload",
      "Return error, status, code, traceId, _environment with isError true.",
    );
  });

  it("C6: undefined status/code/traceId are omitted", async () => {
    const h = harness({
      set: ONE(),
      impl: {
        a: async () => {
          throw new Error("plain");
        },
      },
    });
    const r = await h.dispatcher.callTool("alpha", {});
    eq(
      r.content[0].text,
      JSON.stringify({ error: "plain", _environment: ENV_A }),
      "handler error minimal",
      "C6: absent properties are omitted",
      "Only include status/code/traceId when the error has them.",
    );
  });

  it("C6: an API key inside the error message is replaced by a fixed text", async () => {
    const h = harness({
      set: ONE(),
      impl: {
        a: async () => {
          throw new Error(`request failed for ${KEY_A} twice ${KEY_A}`);
        },
      },
    });
    const r = await h.dispatcher.callTool("alpha", {});
    const message = parse(r).error as string;
    ok(
      r.isError === true &&
        !r.content[0].text.includes(KEY_A) &&
        !allLogged(h).includes(KEY_A) &&
        message.startsWith("request failed for ") &&
        message.length > "request failed for  twice ".length,
      "key in error message",
      "C6: key text never leaves the dispatcher",
      "message keeps surrounding text, with the key replaced by a fixed placeholder, in result and logs",
      message,
      "Scrub the profile's API key from error messages.",
    );
    const again = parse(await h.dispatcher.callTool("alpha", {})).error;
    eq(
      again,
      message,
      "placeholder stability",
      "C6: replacement text is fixed",
      "Use the same replacement text each time.",
    );
  });

  it("C6: _environment identifies the failing environment", async () => {
    const h = harness({
      set: TWO(),
      impl: {
        b: async () => {
          throw new Error("b failed");
        },
      },
    });
    eq(
      parse(await h.dispatcher.callTool("alpha", { environment: "b" }))
        ._environment,
      ENV_B,
      "error _environment",
      "C6: same _environment as success",
      "Attach the serving environment to errors.",
    );
  });
});

describe("C7 rate limiting", () => {
  it("C7: checks the limiter once with the profile name, after resolve and before the handler", async () => {
    const order: string[] = [];
    const h = harness({
      set: TWO(),
      impl: {
        b: async () => {
          order.push("handler");
          return {};
        },
      },
    });
    h.rateLimiter.check.mockImplementation((k) => {
      order.push(`check:${k}`);
      return true;
    });
    await h.dispatcher.callTool("alpha", { environment: "b" });
    eq(
      order,
      ["check:b", "handler"],
      "limiter order",
      "C7: exactly one check keyed by profile name before the handler",
      "Rate limit by profile name, once, before running the handler.",
    );
  });

  it("C7: a denied call skips the handler and returns a non-error Rate limit exceeded payload", async () => {
    const h = harness({ set: TWO() });
    h.rateLimiter.check.mockReturnValue(false);
    const r = await h.dispatcher.callTool("alpha", { environment: "b" });
    eq(
      r,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Rate limit exceeded",
              _environment: ENV_B,
            }),
          },
        ],
      },
      "rate limited",
      "C7: exact payload, no isError",
      "Return the rate-limit text without isError (existing behaviour).",
    );
    eq(
      Object.values(h.handlerCalls).map((m) => m.mock.calls.length),
      [0],
      "rate limited handler",
      "C7: handler never runs",
      "Do not run the handler when denied.",
    );
  });

  it("C7: environments use independent buckets", async () => {
    const h = harness({ set: TWO() });
    h.rateLimiter.check.mockImplementation((k) => k !== "b");
    const a = await h.dispatcher.callTool("alpha", { environment: "a" });
    const b = await h.dispatcher.callTool("alpha", { environment: "b" });
    eq(
      [parse(a).error, parse(b).error],
      [undefined, "Rate limit exceeded"],
      "independent buckets",
      "C7: denying b does not affect a",
      "Key the limiter per environment name.",
    );
    eq(
      h.rateLimiter.check.mock.calls,
      [["a"], ["b"]],
      "limiter keys",
      "C7: keys are profile names, never keys or prefixes",
      "Never key the limiter on API key material.",
    );
  });
});

describe("C9 logging", () => {
  it("C9: logs once at info with 'Tool call received: <name>' and the environment name", async () => {
    const h = harness({ set: TWO() });
    await h.dispatcher.callTool("alpha", { environment: "b", x: "1" });
    eq(
      h.logger.info.mock.calls.length,
      1,
      "info log count",
      "C9: exactly one info log per call",
      "Log the call once at info level.",
    );
    const [message, meta] = h.logger.info.mock.calls[0];
    ok(
      message.startsWith("Tool call received: alpha") &&
        (meta as Record<string, unknown>).environment === "b",
      "info log content",
      "C9: message prefix and meta.environment",
      "message starting 'Tool call received: alpha' with meta.environment 'b'",
      JSON.stringify([message, meta]),
      "Include the tool name and the environment name.",
    );
  });

  it("C9: environment meta is undefined when resolution failed, and still one info log", async () => {
    const h = harness({ set: TWO() });
    await h.dispatcher.callTool("alpha", { environment: "zzz" });
    eq(
      h.logger.info.mock.calls.length,
      1,
      "info log count on failure",
      "C9: one info log even when resolution fails",
      "Log every call.",
    );
    const meta = h.logger.info.mock.calls[0][1] as Record<string, unknown>;
    eq(
      meta?.environment,
      undefined,
      "failed-resolution environment meta",
      "C9: environment undefined when not resolved",
      "Do not log an unvalidated name as the environment.",
    );
  });

  it("C9: no log call contains an API key on success, handler error and rate-limit paths", async () => {
    const h = harness({
      set: TWO(),
      impl: {
        b: async () => {
          throw new Error(`leak ${KEY_B}`);
        },
      },
    });
    await h.dispatcher.callTool("alpha", { environment: "a", x: KEY_A });
    await h.dispatcher.callTool("alpha", { environment: "b" });
    h.rateLimiter.check.mockReturnValue(false);
    await h.dispatcher.callTool("alpha", { environment: "a" });
    const logged = allLogged(h);
    for (const k of [KEY_A, KEY_B])
      ok(
        !logged.includes(k),
        "key in logs",
        "C9: no API key in any log message or meta",
        "no key text in logs",
        `found ${k.slice(0, 13)}...`,
        "Never log API keys, including arguments echoing them or error text.",
      );
  });
});
