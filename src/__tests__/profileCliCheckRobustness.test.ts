import { describe, it } from "@jest/globals";
import {
  KEY,
  OPENAPI_URL,
  PROJECTS_URL,
  makeHarness,
  mkProfile,
  mkSet,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const DEV = mkProfile("dev");
const PROD = mkProfile("prod");
const all = (h: { outText(): string; errText(): string }): string =>
  h.outText() + h.errText();
const failLine = (name: string, reason: string): RegExp =>
  new RegExp(
    `^FAIL\\s+${name}\\s+api-${name}\\.cognigy\\.ai\\s+${reason}$`,
    "m",
  );
const never = (): Promise<never> => new Promise<never>(() => undefined);
const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function coded(code: unknown, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`msg ${KEY} https://secret.example/x`), {
    code,
    ...extra,
  });
}

describe("failure reason mapping by error code (change F1)", () => {
  const TABLE: [string, unknown, string][] = [
    ["ENOTFOUND", "ENOTFOUND", "DNS lookup failed"],
    ["EAI_AGAIN", "EAI_AGAIN", "DNS lookup failed"],
    ["ETIMEDOUT", "ETIMEDOUT", "timed out"],
    ["ECONNABORTED", "ECONNABORTED", "timed out"],
    ["ESOCKETTIMEDOUT", "ESOCKETTIMEDOUT", "timed out"],
    ["ECONNREFUSED", "ECONNREFUSED", "connection refused"],
    ["ECONNRESET", "ECONNRESET", "connection reset"],
    ["CERT_HAS_EXPIRED", "CERT_HAS_EXPIRED", "TLS error"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "TLS error",
    ],
    [
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "TLS error",
    ],
    [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "TLS error",
    ],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "DEPTH_ZERO_SELF_SIGNED_CERT", "TLS error"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "SELF_SIGNED_CERT_IN_CHAIN", "TLS error"],
    ["unknown code", "EWHATEVER", "request failed"],
    ["empty code", "", "request failed"],
    ["numeric code", 5, "request failed"],
  ];

  it.each(TABLE)("code %s => `%s`", async (_l, code, reason) => {
    const h = makeHarness({
      set: mkSet([DEV]),
      httpHandler: () => {
        throw coded(code);
      },
    });
    await runExpect(
      h,
      ["test", "dev"],
      2,
      `profile test (code ${_l}) exits 2`,
      "Change F1: reasons map from the error's code",
      "Return 2 on failure",
    );
    ok(
      failLine("dev", reason).test(all(h)),
      `profile test (code ${_l}) reason`,
      `Change F1: code ${_l} => ${reason}`,
      `FAIL  dev  api-dev.cognigy.ai  ${reason}`,
      JSON.stringify(all(h)),
      "Map the error code to the fixed reason text",
    );
    mustNotContain(
      all(h),
      ["secret.example", "msg "],
      `profile test (code ${_l}) hides message`,
      "Change F1: never the message",
      "Print only the fixed reason",
    );
  });

  it("numeric status wins over code", async () => {
    const h = makeHarness({
      set: mkSet([DEV]),
      httpHandler: () => {
        throw coded("ENOTFOUND", { status: 502 });
      },
    });
    await runExpect(
      h,
      ["test", "dev"],
      2,
      "profile test (status+code) exits 2",
      "Change F1",
      "Return 2",
    );
    ok(
      failLine("dev", "HTTP 502").test(all(h)),
      "profile test (status+code) reason",
      "Change F1: numeric status first",
      "HTTP 502",
      JSON.stringify(all(h)),
      "Prefer the status",
    );
  });

  it("a code-like message without a code property is `request failed`", async () => {
    const h = makeHarness({
      set: mkSet([DEV]),
      httpHandler: () => {
        throw new Error("getaddrinfo ENOTFOUND api-dev.cognigy.ai");
      },
    });
    await runExpect(
      h,
      ["test", "dev"],
      2,
      "profile test (message only) exits 2",
      "Change F1",
      "Return 2",
    );
    ok(
      failLine("dev", "request failed").test(all(h)),
      "profile test (message only) reason",
      "Change F1: never classify by message",
      "request failed",
      JSON.stringify(all(h)),
      "Use only the code property",
    );
  });
});

describe("per-environment deadline (change F2)", () => {
  it("a hung check is `timed out`, the next environment proceeds, exit 2, no hang", async () => {
    const started = Date.now();
    const h = makeHarness({
      set: mkSet([DEV, PROD]),
      checkTimeoutMs: 30,
      httpHandler: (name, url) =>
        name === "dev"
          ? never()
          : url === OPENAPI_URL
            ? { info: { version: "2026.21.0" } }
            : { items: [] },
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all with a hung env exits 2",
      "Change F2: deadline failure counts as failure",
      "Return 2",
    );
    ok(
      Date.now() - started < 3000,
      "profile test --all hung env duration",
      "Change F2: does not hang",
      "finishes well under 3000 ms",
      `${Date.now() - started} ms`,
      "Enforce the overall deadline",
    );
    ok(
      failLine("dev", "timed out").test(all(h)),
      "profile test hung env line",
      "Change F2: `FAIL <name> <host> timed out`",
      "FAIL  dev  api-dev.cognigy.ai  timed out",
      JSON.stringify(all(h)),
      "Report timed out",
    );
    ok(
      /^ok\s+prod\s+api-prod\.cognigy\.ai\s+release 2026\.21\.0$/m.test(all(h)),
      "profile test next env still runs",
      "Change F2: next environment proceeds",
      "ok line for prod",
      JSON.stringify(all(h)),
      "Continue after a timeout",
    );
    mustContain(
      all(h),
      ["1 of 2 environments failed"],
      "profile test summary after timeout",
      "Change F2",
      "Count the timeout as a failure",
    );
  });

  it("a late resolution after the deadline does not produce a second line", async () => {
    const h = makeHarness({
      set: mkSet([DEV]),
      checkTimeoutMs: 30,
      httpHandler: async (_n, url) => {
        await wait(120);
        return url === OPENAPI_URL
          ? { info: { version: "2026.21.0" } }
          : { items: [] };
      },
    });
    await runExpect(
      h,
      ["test", "dev"],
      2,
      "profile test (late) exits 2",
      "Change F2",
      "Return 2",
    );
    const snapshot = all(h);
    await wait(350);
    eq(
      all(h),
      snapshot,
      "profile test late resolution adds no output",
      "Change F2: output after the deadline is ignored",
      "Ignore results that arrive after the deadline",
    );
    eq(
      (snapshot.match(/^(ok|FAIL)\s+dev\b/gm) ?? []).length,
      1,
      "profile test late: one result line for dev",
      "Change F2",
      "Print exactly one line per environment",
    );
  });

  it("a fast check under the deadline is unaffected", async () => {
    const h = makeHarness({ set: mkSet([DEV]), checkTimeoutMs: 2000 });
    await runExpect(
      h,
      ["test", "dev"],
      0,
      "profile test (fast) exits 0",
      "Change F2",
      "Succeed",
    );
    eq(
      h.gets,
      [`dev ${PROJECTS_URL}`, `dev ${OPENAPI_URL}`],
      "profile test (fast) requests",
      "Change F2",
      "Same checks",
    );
  });

  it("the post-add check has the same deadline: saved, WARNING mentioning timed out, exit 0", async () => {
    const started = Date.now();
    const h = makeHarness({
      env: { CGKEY: KEY } as NodeJS.ProcessEnv,
      checkTimeoutMs: 30,
      httpHandler: () => never(),
    });
    await runExpect(
      h,
      [
        "add",
        "dev",
        "--api-base-url",
        "https://api-dev.cognigy.ai",
        "--api-key-env",
        "CGKEY",
      ],
      0,
      "profile add with a hung check exits 0",
      "Change F2: the deadline applies to the post-add check",
      "Warn and succeed",
    );
    ok(
      Date.now() - started < 3000,
      "profile add hung check duration",
      "Change F2",
      "finishes well under 3000 ms",
      `${Date.now() - started} ms`,
      "Enforce the deadline",
    );
    eq(
      h.upserts.length,
      1,
      "profile add hung check keeps the write",
      "Spec 1",
      "Keep the saved profile",
    );
    mustContain(
      all(h),
      ["WARNING", "saved", "timed out"],
      "profile add hung check output",
      "Spec 1 + Change F2",
      "Warn that the check timed out",
    );
  });
});
