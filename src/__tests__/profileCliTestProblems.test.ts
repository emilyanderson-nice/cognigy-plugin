/**
 * Defect B: `profile test --all` must report names that have NO usable profile
 * (ProfileSet.problems) as failed environments.
 *
 * Line format : `FAIL  <name>  -  unusable: <reason>`  (hyphen where the host goes)
 * Summary     : `N of M environments failed`, M = usable + distinct unusable names
 * Exit code   : 2 whenever N > 0; unusable names come AFTER the usable ones,
 *               in name order; no usable profile but problems => still exit 2.
 */
import { describe, it } from "@jest/globals";
import { runProfileCommand } from "../profiles/profileCli.js";
import { loadProfiles } from "../profiles/profiles.js";
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
const R_BAD = "missing API key";
const R_BAD2 = "second reason for the same name";
const R_OTHER = "invalid base URL";

const all = (h: Harness): string => h.outText() + h.errText();
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const failLine = (name: string, reason: string): RegExp =>
  new RegExp(`^FAIL  ${esc(name)}  -  unusable: ${esc(reason)}$`, "m");
const count = (text: string, re: RegExp): number =>
  text.split(/\r?\n/).filter((l) => re.test(l)).length;

/** Records every write in order across out and err. */
function interleave(h: Harness): () => string {
  const seq: string[] = [];
  const o = h.deps.out;
  const e = h.deps.err;
  h.deps.out = (t) => {
    seq.push(t);
    o(t);
  };
  h.deps.err = (t) => {
    seq.push(t);
    e(t);
  };
  return () => seq.join("");
}

describe("profile test --all: unusable names are failed environments (Defect B)", () => {
  it("one valid + one broken: both lines, summary `1 of 2`, exit 2, only the valid one is requested", async () => {
    const h = makeHarness({
      set: mkSet([DEV], "dev", [{ name: "bad", reason: R_BAD }]),
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all (1 valid, 1 unusable) exits 2",
      "Defect B: an unusable environment is a failed environment",
      "Return 2 when any environment, including an unusable one, failed",
    );
    ok(
      failLine("bad", R_BAD).test(all(h)),
      "profile test --all FAIL line for the unusable name",
      "Defect B.1: `FAIL  <name>  -  unusable: <reason>`",
      `a line exactly: FAIL  bad  -  unusable: ${R_BAD}`,
      JSON.stringify(all(h)),
      "Print one FAIL line per unusable name with two spaces between columns and a hyphen in place of the host",
    );
    ok(
      /^ok\s+dev\s+api-dev\.cognigy\.ai\s+release 2026\.21\.0$/m.test(
        h.outText(),
      ),
      "profile test --all still tests the valid profile",
      "Defect B.2: usable profiles are still tested",
      "ok line for dev",
      JSON.stringify(h.outText()),
      "Keep testing usable profiles",
    );
    mustContain(
      all(h),
      ["1 of 2 environments failed"],
      "profile test --all summary",
      "Defect B.2: M = usable + distinct unusable names, N = failures + unusable names",
      "Count the unusable name as a failed environment",
    );
    eq(
      h.getters.map((p) => p.name),
      ["dev"],
      "profile test --all getters",
      "Defect B: no request is made for an unusable name",
      "Create a connection only for usable profiles",
    );
  });

  it("only broken names: exit 2 (not 1), FAIL line, summary `1 of 1`, no getter, no 'No environments' message", async () => {
    const h = makeHarness({
      set: mkSet([], undefined, [{ name: "bad", reason: R_BAD }]),
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all (only unusable) exits 2",
      "Defect B.3: problems without usable profiles are failures, not an empty configuration",
      "Report the unusable names and return 2",
    );
    ok(
      failLine("bad", R_BAD).test(all(h)),
      "profile test --all (only unusable) FAIL line",
      "Defect B.1",
      `a line exactly: FAIL  bad  -  unusable: ${R_BAD}`,
      JSON.stringify(all(h)),
      "Print the FAIL line",
    );
    mustContain(
      all(h),
      ["1 of 1 environments failed"],
      "profile test --all (only unusable) summary",
      "Defect B.3",
      "Print the summary",
    );
    mustNotContain(
      all(h),
      ["No environments are configured"],
      "profile test --all (only unusable) message",
      "Defect B.3: do not claim nothing is configured",
      "Omit the empty-configuration message when problems exist",
    );
    eq(
      h.getters.length,
      0,
      "profile test --all (only unusable) getters",
      "Defect B",
      "No requests",
    );
  });

  it("the same unusable name twice is one environment, with the FIRST reason", async () => {
    const h = makeHarness({
      set: mkSet([DEV], "dev", [
        { name: "bad", reason: R_BAD },
        { name: "bad", reason: R_BAD2 },
        { name: "other", reason: R_OTHER },
      ]),
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all (duplicate problems) exits 2",
      "Defect B.2",
      "Return 2",
    );
    eq(
      [
        count(all(h), /^FAIL {2}bad {2}- {2}unusable: /),
        count(all(h), /^FAIL {2}other {2}- {2}unusable: /),
      ],
      [1, 1],
      "profile test --all (duplicate problems) FAIL lines",
      "Defect B.1: one line per distinct name",
      "Dedupe unusable names",
    );
    ok(
      failLine("bad", R_BAD).test(all(h)) &&
        failLine("other", R_OTHER).test(all(h)),
      "profile test --all (duplicate problems) reasons",
      "Defect B.1: the first reason of a name is used",
      `FAIL lines with ${JSON.stringify(R_BAD)} and ${JSON.stringify(R_OTHER)}`,
      JSON.stringify(all(h)),
      "Use the first reason recorded for each name",
    );
    mustNotContain(
      all(h),
      [R_BAD2],
      "profile test --all (duplicate problems) later reason",
      "Defect B.1",
      "Do not print later reasons",
    );
    mustContain(
      all(h),
      ["2 of 3 environments failed"],
      "profile test --all (duplicate problems) summary",
      "Defect B.2: distinct names count once (1 usable + 2 unusable = 3, 2 failed)",
      "Count distinct unusable names",
    );
  });

  it("check failures and unusable names add up in one summary", async () => {
    const h = makeHarness({
      set: mkSet([DEV, mkProfile("prod")], "dev", [
        { name: "bad", reason: R_BAD },
      ]),
      httpHandler: (name, url) => {
        if (name === "prod" && url === PROJECTS_URL)
          throw Object.assign(new Error("x"), { status: 503 });
        return url === OPENAPI_URL
          ? { info: { version: "2026.21.0" } }
          : { items: [] };
      },
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all (check failure + unusable) exits 2",
      "Defect B.2",
      "Return 2",
    );
    mustContain(
      all(h),
      ["2 of 3 environments failed"],
      "profile test --all (check failure + unusable) summary",
      "Defect B.2: N = check failures (1) + unusable names (1); M = 2 usable + 1 unusable",
      "Add unusable names to both numbers",
    );
  });

  it("order: usable profiles by name, then unusable names by name, then the summary", async () => {
    const h = makeHarness({
      set: mkSet([mkProfile("zeta"), mkProfile("alpha")], "alpha", [
        { name: "yy", reason: R_OTHER },
        { name: "bb", reason: R_BAD },
      ]),
    });
    const written = interleave(h);
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all (ordering) exits 2",
      "Defect B.2",
      "Return 2",
    );
    const text = written();
    const at = (re: RegExp): number => text.search(re);
    const order = [
      at(/^ok\s+alpha\s/m),
      at(/^ok\s+zeta\s/m),
      at(/^FAIL {2}bb {2}- {2}unusable: /m),
      at(/^FAIL {2}yy {2}- {2}unusable: /m),
      at(/2 of 4 environments failed/),
    ];
    ok(
      order.every((i) => i >= 0) &&
        order.every((i, k) => k === 0 || order[k - 1] < i),
      "profile test --all (ordering) output order",
      "Defect B.2: usable (alpha, zeta) then unusable (bb, yy) then the summary",
      "positions strictly increasing: ok alpha, ok zeta, FAIL bb, FAIL yy, summary `2 of 4`",
      JSON.stringify({ order, text }),
      "Test usable profiles first in name order, then list unusable names in name order, then the summary",
    );
    eq(
      h.getters.map((p) => p.name),
      ["alpha", "zeta"],
      "profile test --all (ordering) getters",
      "Defect B.2: usable profiles tested sequentially in name order",
      "Sort usable profiles by name",
    );
  });

  it("no profiles and no problems is unchanged: exit 1 with the empty-configuration message", async () => {
    const h = makeHarness({ set: mkSet([]) });
    await runExpect(
      h,
      ["test", "--all"],
      1,
      "profile test --all (nothing at all) exits 1",
      "Defect B.3: unchanged",
      "Keep exit 1",
    );
    mustContain(
      all(h),
      ["No environments are configured."],
      "profile test --all (nothing at all) message",
      "Defect B.3: unchanged",
      "Keep the message",
    );
    mustNotContain(
      all(h),
      ["unusable:"],
      "profile test --all (nothing at all) output",
      "Defect B",
      "No unusable lines",
    );
  });

  it("without problems the output has no unusable line (unchanged success)", async () => {
    const h = makeHarness({ set: mkSet([DEV], "dev") });
    await runExpect(
      h,
      ["test", "--all"],
      0,
      "profile test --all (no problems) exits 0",
      "Defect B: unchanged",
      "Succeed",
    );
    mustNotContain(
      all(h),
      ["unusable:", "environments failed"],
      "profile test --all (no problems) output",
      "Defect B: unchanged",
      "No failure output",
    );
  });
});

describe("profile test <name> and profile test (default) are unchanged by problems (Defect B.5)", () => {
  const set = mkSet([DEV], "dev", [{ name: "bad", reason: R_BAD }]);

  it("test bad: exit 1 with the reason, no request, no FAIL line format", async () => {
    const h = makeHarness({ set });
    await runExpect(
      h,
      ["test", "bad"],
      1,
      "profile test bad exits 1",
      "Defect B.5: unchanged",
      "Keep exit 1 for a name without a usable profile",
    );
    mustContain(
      all(h),
      [R_BAD],
      "profile test bad reason",
      "Defect B.5: the reason is reported",
      "Print the reason",
    );
    mustNotContain(
      all(h),
      ["FAIL", "environments failed"],
      "profile test bad output",
      "Defect B.5: only --all uses the FAIL/summary format",
      "Keep the single-name output as before",
    );
    eq(h.getters.length, 0, "profile test bad getters", "Defect B.5", "None");
  });

  it.each([["test"], ["test dev"]])(
    "%s: tests only dev, exit 0, ignores the unrelated problem",
    async (cmd) => {
      const h = makeHarness({ set });
      await runExpect(
        h,
        cmd.split(" "),
        0,
        `profile ${cmd} exits 0`,
        "Defect B.5: unchanged",
        "Succeed",
      );
      eq(
        h.getters.map((p) => p.name),
        ["dev"],
        `profile ${cmd} getters`,
        "Defect B.5",
        "Only dev",
      );
      mustNotContain(
        all(h),
        ["unusable:", "environments failed"],
        `profile ${cmd} output`,
        "Defect B.5",
        "No unusable lines outside --all",
      );
    },
  );
});

describe("profile test --all with the REAL pure loader (Defect B integration)", () => {
  it("env profile 'bad' without a key + valid file profile 'good': getter only for good, FAIL line, exit 2", async () => {
    const env = {
      COGNIGY_PROFILE_BAD_API_BASE_URL: "https://api-bad-env.cognigy.ai",
    } as NodeJS.ProcessEnv;
    const load = () =>
      loadProfiles({
        env,
        fileProfiles: {
          profiles: {
            good: { apiBaseUrl: "https://api-good.cognigy.ai", apiKey: KEY },
          },
          problems: [],
        },
      } as never);
    const reason = load().problems.find((p) => p.name === "bad")?.reason;
    ok(
      typeof reason === "string" && reason.length > 0,
      "test setup",
      "the loader must report the env-only profile as a problem",
      "a non-empty reason for bad",
      JSON.stringify(load().problems.map((p) => p.name)),
      "n/a",
    );
    const created: string[] = [];
    let out = "";
    let err = "";
    const code = await runProfileCommand(["test", "--all"], {
      out: (t) => void (out += t),
      err: (t) => void (err += t),
      isTTY: false,
      ask: async () => {
        throw new Error("test: unexpected prompt");
      },
      askHidden: async () => {
        throw new Error("test: unexpected hidden prompt");
      },
      env,
      configPath: "C:\\fake-temp-dir\\cfg\\config.json",
      loadProfiles: load,
      store: {
        upsertProfile: () => {
          throw new Error("test: store must not be used");
        },
        removeProfile: () => {
          throw new Error("test: store must not be used");
        },
        setDefaultProfile: () => {
          throw new Error("test: store must not be used");
        },
      },
      createGetter: (profile) => {
        created.push(profile.name);
        return {
          async get<T = unknown>(url: string): Promise<T> {
            return (
              url === OPENAPI_URL
                ? { info: { version: "2026.21.0" } }
                : { items: [] }
            ) as T;
          },
        };
      },
    });
    const text = out + err;
    eq(
      [code, created],
      [2, ["good"]],
      "profile test --all (real loader)",
      "Defect B: exit 2 and a connection only for the usable profile",
      "Skip unusable names for requests but fail the run",
    );
    ok(
      failLine("bad", reason as string).test(text),
      "profile test --all (real loader) FAIL line",
      "Defect B.1",
      `a line exactly: FAIL  bad  -  unusable: ${reason}`,
      JSON.stringify(text),
      "Report the loader's reason for the unusable name",
    );
    mustContain(
      text,
      ["1 of 2 environments failed"],
      "profile test --all (real loader) summary",
      "Defect B.2",
      "Count the unusable name",
    );
    mustNotContain(
      text,
      [KEY],
      "profile test --all (real loader) secrets",
      "Defect B.4 / Spec 0: no key in output",
      "Never print key material",
    );
  });
});
