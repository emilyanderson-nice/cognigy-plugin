import { describe, it } from "@jest/globals";
import {
  KEY,
  OPENAPI_URL,
  PROJECTS_URL,
  makeHarness,
  mkProfile,
  mkSet,
  type Harness,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const DEV = mkProfile("dev");
const PROD = mkProfile("prod", "env-profile");
const STG = mkProfile("stg", "legacy-file");
const SET = mkSet([STG, DEV, PROD], "prod"); // deliberately not in name order

const all = (h: Harness): string => h.outText() + h.errText();
const okLine = (name: string, rel: string): RegExp =>
  new RegExp(
    `^ok\\s+${name}\\s+api-${name}\\.cognigy\\.ai\\s+release ${rel.replace(/\./g, "\\.")}$`,
    "m",
  );
const failLine = (name: string, reason: string): RegExp =>
  new RegExp(
    `^FAIL\\s+${name}\\s+api-${name}\\.cognigy\\.ai\\s+${reason}$`,
    "m",
  );

describe("profile test: target selection (spec 6)", () => {
  it("no argument tests the default profile only", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["test"],
      0,
      "profile test exits 0",
      "Spec 6",
      "Succeed",
    );
    eq(
      h.getters.map((p) => p.name),
      ["prod"],
      "profile test default target",
      "Spec 6: no argument => the set's default",
      "Test only the default",
    );
    eq(
      h.gets,
      [`prod ${PROJECTS_URL}`, `prod ${OPENAPI_URL}`],
      "profile test default requests",
      "Spec 6: projects first, then release detection",
      "Request both URLs in order",
    );
    ok(
      okLine("prod", "2026.21.0").test(h.outText()),
      "profile test default ok line",
      "Spec 6: `ok <name> <apiHost> release <raw>`",
      "ok  prod  api-prod.cognigy.ai  release 2026.21.0",
      JSON.stringify(h.outText()),
      "Print the ok line",
    );
  });

  it("no argument and no default: exit 1 telling to pass a name or --all and listing names", async () => {
    const h = makeHarness({ set: mkSet([DEV, PROD]) });
    await runExpect(
      h,
      ["test"],
      1,
      "profile test (no default) exits 1",
      "Spec 6",
      "Fail",
    );
    mustContain(
      h.errText(),
      ["--all", "dev", "prod"],
      "profile test no-default message",
      "Spec 6",
      "Mention --all and list names",
    );
    eq(
      h.getters.length,
      0,
      "profile test no-default makes no requests",
      "Spec 6",
      "No requests",
    );
  });

  it("a name is normalised and only that profile is tested", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["test", "DEV"],
      0,
      "profile test DEV exits 0",
      "Spec 6",
      "Succeed",
    );
    eq(
      h.getters.map((p) => p.name),
      ["dev"],
      "profile test named target",
      "Spec 6",
      "Only dev",
    );
    eq(
      h.getters[0]?.apiKey,
      KEY,
      "profile test gives the getter the profile with its key",
      "Spec 6: createGetter(profile)",
      "Pass the full loaded profile",
    );
  });

  it("unknown name exits 1 without requests", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["test", "nope"],
      1,
      "profile test nope exits 1",
      "Spec 6",
      "Fail",
    );
    eq(
      h.getters.length,
      0,
      "profile test nope no requests",
      "Spec 6",
      "No requests",
    );
  });

  it("--all on an empty set exits 1", async () => {
    const h = makeHarness({ set: mkSet([]) });
    await runExpect(
      h,
      ["test", "--all"],
      1,
      "profile test --all (empty) exits 1",
      "Spec 6",
      "Fail",
    );
    eq(
      h.getters.length,
      0,
      "profile test --all (empty) no requests",
      "Spec 6",
      "No requests",
    );
  });

  it("--all tests every profile sequentially in name order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const h = makeHarness({
      set: SET,
      httpHandler: async (_n, url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return url === OPENAPI_URL
          ? { info: { version: "2026.21.0" } }
          : { items: [] };
      },
    });
    await runExpect(
      h,
      ["test", "--all"],
      0,
      "profile test --all exits 0",
      "Spec 6: all ok => 0",
      "Succeed",
    );
    eq(
      h.gets,
      [
        `dev ${PROJECTS_URL}`,
        `dev ${OPENAPI_URL}`,
        `prod ${PROJECTS_URL}`,
        `prod ${OPENAPI_URL}`,
        `stg ${PROJECTS_URL}`,
        `stg ${OPENAPI_URL}`,
      ],
      "profile test --all request order",
      "Spec 6: sequential, in name order (each environment finishes before the next)",
      "Test environments one at a time, sorted by name",
    );
    eq(
      maxInFlight,
      1,
      "profile test --all concurrency",
      "Spec 6: sequential",
      "Never overlap requests",
    );
    for (const n of ["dev", "prod", "stg"]) {
      ok(
        okLine(n, "2026.21.0").test(h.outText()),
        `profile test --all line for ${n}`,
        "Spec 6",
        `ok line for ${n}`,
        JSON.stringify(h.outText()),
        "One line per environment",
      );
    }
    mustNotContain(
      all(h),
      ["environments failed"],
      "profile test --all success has no failure summary",
      "Spec 6: summary only on failure",
      "Omit the summary",
    );
  });
});

describe("profile test: results and exit codes (spec 6)", () => {
  const failing =
    (bad: Record<string, unknown>) =>
    (name: string, url: string): unknown => {
      if (name in bad && url === PROJECTS_URL) throw bad[name];
      return url === OPENAPI_URL
        ? { info: { version: "2026.21.0" } }
        : { items: [] };
    };

  it("numeric status => `HTTP <status>`, exit 2, summary `1 of 3 environments failed`", async () => {
    const h = makeHarness({
      set: SET,
      httpHandler: failing({
        prod: Object.assign(new Error(`nope ${KEY} https://secret.example/x`), {
          status: 503,
        }),
      }),
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all with one failure exits 2",
      "Spec 6: any failure => 2",
      "Return 2",
    );
    ok(
      failLine("prod", "HTTP 503").test(all(h)),
      "profile test FAIL line",
      "Spec 6: `FAIL <name> <apiHost> HTTP <status>`",
      "FAIL  prod  api-prod.cognigy.ai  HTTP 503",
      JSON.stringify(all(h)),
      "Print the FAIL line",
    );
    ok(
      okLine("dev", "2026.21.0").test(all(h)) &&
        okLine("stg", "2026.21.0").test(all(h)),
      "profile test continues after a failure",
      "Spec 6: every environment is tested",
      "ok lines for dev and stg",
      JSON.stringify(all(h)),
      "Do not stop at the first failure",
    );
    mustContain(
      all(h),
      ["1 of 3 environments failed"],
      "profile test summary",
      "Spec 6",
      "Print the summary line",
    );
    mustNotContain(
      all(h),
      ["nope", "secret.example"],
      "profile test hides thrown message",
      "Spec 6: never the thrown message",
      "Print only the status",
    );
  });

  it.each([
    ["no status", new Error(`boom ${KEY}`)],
    ["string status", Object.assign(new Error("x"), { status: "401" })],
    ["non-Error throw", `raw ${KEY}`],
    ["null throw", null],
  ])("%s => fixed text `request failed`", async (_l, thrown) => {
    const h = makeHarness({
      set: mkSet([DEV]),
      httpHandler: failing({ dev: thrown }),
    });
    await runExpect(
      h,
      ["test", "dev"],
      2,
      `profile test (${_l}) exits 2`,
      "Spec 6",
      "Return 2",
    );
    ok(
      failLine("dev", "request failed").test(all(h)),
      `profile test (${_l}) FAIL line`,
      "Spec 6: non-numeric status => `request failed`",
      "FAIL  dev  api-dev.cognigy.ai  request failed",
      JSON.stringify(all(h)),
      "Use the fixed text",
    );
    mustContain(
      all(h),
      ["1 of 1 environments failed"],
      `profile test (${_l}) summary`,
      "Spec 6",
      "Print the summary",
    );
  });

  it("all failing: `2 of 2 environments failed`, exit 2", async () => {
    const e = Object.assign(new Error("x"), { status: 401 });
    const h = makeHarness({
      set: mkSet([DEV, PROD]),
      httpHandler: failing({ dev: e, prod: e }),
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all all failing exits 2",
      "Spec 6",
      "Return 2",
    );
    mustContain(
      all(h),
      ["2 of 2 environments failed"],
      "profile test summary",
      "Spec 6",
      "Count failures",
    );
  });

  it.each([
    [
      "openapi throws",
      (url: string): unknown => {
        if (url === OPENAPI_URL)
          throw Object.assign(new Error(`down ${KEY}`), { status: 500 });
        return { items: [] };
      },
    ],
    [
      "openapi returns no version",
      (url: string): unknown => (url === OPENAPI_URL ? {} : { items: [] }),
    ],
  ])(
    "release detection failure alone (%s) is ok with `release unknown`, exit 0",
    async (_l, fn) => {
      const h = makeHarness({
        set: mkSet([DEV]),
        httpHandler: (_n, url) => fn(url),
      });
      await runExpect(
        h,
        ["test", "dev"],
        0,
        `profile test (${_l}) exits 0`,
        "Spec 6: release failure does not fail the environment",
        "Treat as ok",
      );
      ok(
        okLine("dev", "unknown").test(h.outText()),
        `profile test (${_l}) line`,
        "Spec 6: `release unknown`",
        "ok  dev  api-dev.cognigy.ai  release unknown",
        JSON.stringify(h.outText()),
        "Print release unknown",
      );
    },
  );

  it("never writes to the store and never mutates loaded profiles", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["test", "--all"],
      0,
      "profile test --all exits 0",
      "Spec 6/8",
      "Succeed",
    );
    eq(
      [h.upserts.length, h.removes.length, h.defaults.length],
      [0, 0, 0],
      "profile test store usage",
      "Spec 6: read-only command",
      "Do not write",
    );
    eq(
      SET.profiles.map((p) => [p.name, p.source, p.apiBaseUrl]),
      [
        ["stg", "legacy-file", "https://api-stg.cognigy.ai"],
        ["dev", "file-profile", "https://api-dev.cognigy.ai"],
        ["prod", "env-profile", "https://api-prod.cognigy.ai"],
      ],
      "profile test leaves the loaded set intact (order included)",
      "Spec 8: never mutate loaded profile objects",
      "Sort a copy, not the loaded array",
    );
  });
});
