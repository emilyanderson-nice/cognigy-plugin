/**
 * G1 (real task/session ids reach the call log) and G5 (startupNotices) through
 * buildServerParts.
 */
import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { rig } from "./helpers/bootstrapRig.js";
import { ProfileConfigError } from "../profiles/profiles.js";
import { logger } from "../utils/logger.js";
import { KEY_A, KEY_B, setOf, usable } from "./helpers/dispatchHarness.js";
import { eq, ok, show } from "./helpers/specAssert.js";

const two = () => setOf(usable("A", KEY_A), usable("B", KEY_B));

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("G1 real task context in the call log", () => {
  it("each call logs non-empty taskId and sessionId; taskIds differ, sessionId is stable", async () => {
    const info = jest.spyOn(logger, "info");
    const r = rig(two());
    await r.call("list_resources", { environment: "a" });
    await r.call("list_resources", { environment: "a" });
    const metas = info.mock.calls
      .filter(([m]) =>
        String(m).startsWith("Tool call received: list_resources"),
      )
      .map(([, meta]) => meta as Record<string, unknown>);
    eq(
      metas.length,
      2,
      "real ids: line count",
      "G1: one 'Tool call received' line per call",
      "Log each call once.",
    );
    const [m1, m2] = metas;
    const str = (v: unknown) => typeof v === "string" && v.length > 0;
    ok(
      str(m1.taskId) &&
        str(m2.taskId) &&
        str(m1.sessionId) &&
        str(m2.sessionId),
      "real ids: present",
      "G1: taskId and sessionId are non-empty strings (real actorContext)",
      "four non-empty strings",
      show(metas),
      "Wire the real task and session ids into the dispatcher.",
    );
    ok(
      m1.taskId !== m2.taskId && m1.sessionId === m2.sessionId,
      "real ids: relation",
      "G1: a new taskId per call, the same sessionId for the server's lifetime",
      "different taskIds, equal sessionIds",
      show(metas),
      "One task id per call; one session id per process.",
    );
    eq(
      [m1.environment, m2.environment],
      ["a", "a"],
      "real ids: environment",
      "G1: environment stays in the meta",
      "Keep the environment name.",
    );
  });
});

describe("G5 startupNotices", () => {
  it("zero environments: one notice pointing at cognigy-setup profile add", () => {
    const n = rig(setOf()).parts.startupNotices();
    ok(
      n.length === 1 && n[0].includes("cognigy-setup profile add"),
      "notices zero",
      "G5: exactly one notice mentioning `cognigy-setup profile add`",
      "one notice with the remedy",
      show(n),
      "Tell the operator how to add an environment.",
    );
  });

  it("load error: one notice with the error text, not the 'none configured' advice", () => {
    const r = rig(two());
    r.throwOnLoad(new ProfileConfigError("config.json is not valid JSON"));
    const n = r.parts.startupNotices();
    ok(
      n.length === 1 &&
        n[0].includes("config.json is not valid JSON") &&
        !n[0].includes("No Cognigy environment is configured") &&
        !n[0].includes("profile add"),
      "notices load error",
      "G5: one notice with the loadError, never the zero-environment advice",
      "one notice containing the error, without 'No Cognigy environment is configured' or 'profile add'",
      show(n),
      "Report an unreadable configuration as such, not as an empty one.",
    );
  });

  it("one or more usable environments: no notices", () => {
    eq(
      [
        rig(setOf(usable("A", KEY_A))).parts.startupNotices(),
        rig(two()).parts.startupNotices(),
      ],
      [[], []],
      "notices usable",
      "G5: nothing to announce when environments exist",
      "Return an empty list.",
    );
  });

  it("is evaluated on demand from a fresh snapshot", () => {
    const r = rig(setOf());
    const before = r.parts.startupNotices().length;
    r.set(two());
    const after = r.parts.startupNotices();
    eq(
      [before, after],
      [1, []],
      "notices on demand",
      "G5: each call re-reads configuration",
      "Do not cache the notices at build time.",
    );
  });

  it("no notice leaks a key", () => {
    const r = rig(two());
    r.throwOnLoad(new ProfileConfigError("config.json is not valid JSON"));
    ok(
      !JSON.stringify(r.parts.startupNotices()).includes(KEY_A),
      "notices secrecy",
      "G5: notices never hold keys",
      "no key text",
      "key found",
      "Keep credentials out of notices.",
    );
  });
});
