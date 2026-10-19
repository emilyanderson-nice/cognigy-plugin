/**
 * G1: every call logs exactly one `Tool call received: <name>` info line,
 * emitted inside runWithTask, carrying { environment, taskId, sessionId } so a
 * log line can be matched to an audit event.
 */
import { describe, it } from "@jest/globals";
import {
  KEY_A,
  KEY_B,
  allLogged,
  broken,
  harness,
  setOf,
  tool,
  usable,
} from "./helpers/dispatchHarness.js";
import { eq, ok, show } from "./helpers/specAssert.js";

const TWO = () => setOf(usable("A", KEY_A), usable("B", KEY_B));
const NAME = "alpha";
const CTX = { taskId: "task-123", sessionId: "session-456" };

/** A harness whose taskContext only answers while runWithTask is active. */
function rig(opts: Parameters<typeof harness>[0] = { set: TWO() }) {
  const state = { inTask: false, evaluatedOutside: 0 };
  const h = harness({
    ...opts,
    tools: [tool(NAME), tool("talk_to_agent")],
    taskContext: () => {
      if (!state.inTask) {
        state.evaluatedOutside++;
        return {};
      }
      return CTX;
    },
  });
  h.runWithTask.mockImplementation(async (fn) => {
    state.inTask = true;
    try {
      return await fn();
    } finally {
      state.inTask = false;
    }
  });
  return { h, state };
}

const received = (h: ReturnType<typeof harness>) =>
  h.logger.info.mock.calls.filter(([m]) =>
    String(m).startsWith(`Tool call received: ${NAME}`),
  );

const expectOneLine = (
  h: ReturnType<typeof harness>,
  environment: string | undefined,
  what: string,
) => {
  const lines = received(h);
  eq(
    lines.length,
    1,
    `${what}: line count`,
    "G1: exactly one 'Tool call received' info line per call",
    "Log each call once, whatever its outcome.",
  );
  const meta = lines[0][1] as Record<string, unknown>;
  eq(
    [meta?.environment, meta?.taskId, meta?.sessionId],
    [environment, CTX.taskId, CTX.sessionId],
    `${what}: meta`,
    "G1: meta carries environment, and the taskId/sessionId read inside the task",
    "Evaluate the task context inside runWithTask and log it with the environment.",
  );
};

describe("G1 task context in the call log", () => {
  it("success: one line with environment and ids, read inside the task", async () => {
    const { h, state } = rig();
    await h.dispatcher.callTool(NAME, { environment: "a" });
    expectOneLine(h, "a", "success");
    eq(
      state.evaluatedOutside,
      0,
      "success: evaluated inside task",
      "G1: taskContext is only evaluated while runWithTask is active",
      "Read ids inside the task wrapper, not before it.",
    );
  });

  it("handler error: still exactly one line", async () => {
    const { h } = rig({
      set: TWO(),
      impl: {
        a: async () => {
          throw new Error(`boom ${KEY_A}`);
        },
      },
    });
    await h.dispatcher.callTool(NAME, { environment: "a" });
    expectOneLine(h, "a", "handler error");
    ok(
      !allLogged(h).includes(KEY_A),
      "handler error: no key",
      "G1: no log line contains a key",
      "no key text",
      "key found",
      "Redact before logging.",
    );
  });

  it("rate limited: the call is still logged with ids", async () => {
    const { h, state } = rig();
    h.rateLimiter.check.mockReturnValue(false);
    await h.dispatcher.callTool(NAME, { environment: "b" });
    expectOneLine(h, "b", "rate limited");
    eq(
      state.evaluatedOutside,
      0,
      "rate limited: inside task",
      "G1: rate-limited calls also evaluate the context inside the task",
      "Wrap the rate-limited path in the task too.",
    );
    eq(
      h.handlerCalls["b"]?.mock.calls.length ?? 0,
      0,
      "rate limited: not executed",
      "G1: logging does not execute the tool",
      "Still refuse the call.",
    );
  });

  it.each([
    ["unknown environment", { environment: "zzz" }],
    ["ambiguous (no environment)", {}],
  ])(
    "resolution failure (%s): logged with environment undefined and ids",
    async (_l, args) => {
      const { h, state } = rig();
      const r = await h.dispatcher.callTool(NAME, args);
      ok(
        r.isError === true,
        `${_l}: refused`,
        "G1: fixture is a resolution failure",
        "isError",
        show(r),
        "Keep refusing.",
      );
      expectOneLine(h, undefined, _l);
      eq(
        state.evaluatedOutside,
        0,
        `${_l}: inside task`,
        "G1: resolution failures also log inside the task",
        "Wrap failures in the task too.",
      );
    },
  );

  it("broken environment: logged once with environment undefined", async () => {
    const { h } = rig({ set: setOf(usable("A", KEY_A), broken("B")) });
    await h.dispatcher.callTool(NAME, { environment: "b" });
    expectOneLine(h, undefined, "broken");
  });

  it("without taskContext the line has no ids", async () => {
    const h = harness({ set: TWO() });
    await h.dispatcher.callTool("alpha", { environment: "a" });
    const lines = h.logger.info.mock.calls.filter(([m]) =>
      String(m).startsWith("Tool call received: alpha"),
    );
    const meta = lines[0][1] as Record<string, unknown>;
    eq(
      [lines.length, meta.environment, meta.taskId, meta.sessionId],
      [1, "a", undefined, undefined],
      "no taskContext",
      "G1: ids omitted or undefined when taskContext is absent",
      "Make taskContext optional.",
    );
  });

  it("two calls each read the context afresh", async () => {
    let n = 0;
    const h = harness({
      set: TWO(),
      taskContext: () => ({ taskId: `t${++n}`, sessionId: "s" }),
    });
    await h.dispatcher.callTool("alpha", { environment: "a" });
    await h.dispatcher.callTool("alpha", { environment: "a" });
    eq(
      h.logger.info.mock.calls.map(
        ([, m]) => (m as Record<string, unknown>).taskId,
      ),
      ["t1", "t2"],
      "fresh context per call",
      "G1: the context is evaluated per call, not cached",
      "Call taskContext once for each tool call.",
    );
  });
});
