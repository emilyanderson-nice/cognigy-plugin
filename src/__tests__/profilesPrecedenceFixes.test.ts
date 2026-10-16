/**
 * Defects 2 and 3 in the REAL pure loader (explicit env / legacyFile /
 * fileProfiles, no I/O).
 *
 * Precedence for one name, highest first:
 *   env-profile > legacy-env (only "default") > file-profile > legacy-file (only "default")
 *
 * Defect 2: an unusable higher-precedence definition REMOVES the lower profile.
 * Defect 3: a usable winner drops problems from LOWER sources of the same name,
 * and when nothing is usable the reason comes from the highest failing source.
 */
import { describe, it } from "@jest/globals";
import {
  ProfileConfigError,
  getProfile,
  loadProfiles,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import { eq, fail, ok, show } from "./helpers/specAssert.js";

const P = "COGNIGY_PROFILE_";
const LOWER_KEY = "fake-key-lower-bbbb";
const ENV_KEY = "fake-key-env-aaaa";
const OTHER = {
  apiBaseUrl: "https://api-other.cognigy.ai",
  apiKey: "fake-key-o",
};

type Env = Record<string, string | undefined>;
interface Input {
  env: Env;
  legacyFile?: Record<string, string>;
  fileProfiles?: {
    defaultProfile?: string;
    profiles: Record<string, unknown>;
    problems: { name: string; reason: string }[];
  };
}

const load = (i: Input): ProfileSet => loadProfiles(i as never);
const files = (
  profiles: Record<string, unknown>,
  problems: { name: string; reason: string }[] = [],
  defaultProfile?: string,
): NonNullable<Input["fileProfiles"]> =>
  defaultProfile === undefined
    ? { profiles, problems }
    : { defaultProfile, profiles, problems };
const names = (s: ProfileSet): string[] => s.profiles.map((p) => p.name).sort();
const reasonsFor = (s: ProfileSet, name: string): string[] =>
  s.problems.filter((p) => p.name === name).map((p) => p.reason);

/** Reason the loader reports for `name` when only the given sources exist. */
function isolatedReason(name: string, i: Input): string {
  const reasons = reasonsFor(load(i), name);
  if (reasons.length === 0)
    throw new Error(`test setup: no problem recorded for ${name}`);
  return reasons[0];
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Asserts fn throws ProfileConfigError whose message holds every needle. */
function expectConfigError(
  fn: () => unknown,
  needles: string[],
  forbidden: string[],
  what: string,
  why: string,
  guidance: string,
): void {
  const e = thrownBy(fn);
  if (!(e instanceof ProfileConfigError)) {
    fail(
      what,
      why,
      "throws ProfileConfigError",
      e === undefined ? "returned normally" : show(e),
      guidance,
    );
  }
  const m = (e as Error).message;
  const missing = needles.filter((n) => !m.includes(n));
  const present = forbidden.filter((n) => m.includes(n));
  ok(
    missing.length === 0 && present.length === 0,
    what,
    why,
    `message containing ${JSON.stringify(needles)} and none of ${JSON.stringify(forbidden)}`,
    JSON.stringify(m),
    guidance,
  );
}

interface Case2 {
  label: string;
  name: string;
  input: Input;
  /** Only the failing higher-precedence source(s). */
  higherOnly: Input;
  /** Env var / file default selecting the broken name. */
  selectEnv: Env;
}

const FILE_PROD = {
  apiBaseUrl: "https://api-prod-file.cognigy.ai",
  apiKey: LOWER_KEY,
};
const ENV_URL_ONLY = (n: string): Env => ({
  [`${P}${n}_API_BASE_URL`]: "https://api-prod-env.cognigy.ai",
});
const LEGACY_VALID = {
  COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
  COGNIGY_API_KEY: LOWER_KEY,
};

const CASES2: Case2[] = [
  {
    label: "env-invalid over file-valid",
    name: "prod",
    input: {
      env: { ...ENV_URL_ONLY("PROD"), COGNIGY_PROFILE: "other" },
      fileProfiles: files({ prod: FILE_PROD, other: OTHER }),
    },
    higherOnly: { env: ENV_URL_ONLY("PROD") },
    selectEnv: { COGNIGY_PROFILE: "prod" },
  },
  {
    label: "env-invalid over legacy-file default",
    name: "default",
    input: {
      env: { ...ENV_URL_ONLY("DEFAULT"), COGNIGY_PROFILE: "other" },
      legacyFile: LEGACY_VALID,
      fileProfiles: files({ other: OTHER }),
    },
    higherOnly: { env: ENV_URL_ONLY("DEFAULT") },
    selectEnv: { COGNIGY_PROFILE: "default" },
  },
  {
    label: "env-profile default invalid over legacy-env valid",
    name: "default",
    input: {
      env: {
        COGNIGY_API_BASE_URL: "https://api-legacyenv.cognigy.ai",
        COGNIGY_API_KEY: LOWER_KEY,
        ...ENV_URL_ONLY("DEFAULT"),
        COGNIGY_PROFILE: "other",
      },
      fileProfiles: files({ other: OTHER }),
    },
    higherOnly: { env: ENV_URL_ONLY("DEFAULT") },
    selectEnv: { COGNIGY_PROFILE: "default" },
  },
  {
    label: "file default with wrongly typed apiKey over legacy-file valid",
    name: "default",
    input: {
      env: { COGNIGY_PROFILE: "other" },
      legacyFile: LEGACY_VALID,
      fileProfiles: files({
        default: { apiBaseUrl: "https://api-file.cognigy.ai", apiKey: 123 },
        other: OTHER,
      }),
    },
    higherOnly: {
      env: {},
      fileProfiles: files({
        default: { apiBaseUrl: "https://api-file.cognigy.ai", apiKey: 123 },
      }),
    },
    selectEnv: { COGNIGY_PROFILE: "default" },
  },
];

describe("Defect 2: an unusable higher-precedence definition removes the lower profile", () => {
  describe.each(CASES2)("$label", (c) => {
    it("leaves the name without a profile and records the higher problem", () => {
      const what = `loadProfiles(${c.label})`;
      const reason = isolatedReason(c.name, c.higherOnly);
      const set = load(c.input);
      eq(
        names(set),
        ["other"],
        what,
        "Defect 2: the lower-precedence profile must not survive a failed higher definition",
        "Remove the lower-precedence profile of that name from the usable profiles",
      );
      ok(
        reasonsFor(set, c.name).includes(reason),
        what,
        "Defect 2: set.problems contains the higher-precedence problem",
        `a problem {name:"${c.name}"} with reason ${JSON.stringify(reason)}`,
        show(set.problems),
        "Keep the higher-precedence reason in the problem list",
      );
      eq(
        set.problems.every(
          (p) => Object.keys(p).sort().join() === "name,reason",
        ),
        true,
        what,
        "Defect 3: ProfileProblem keeps exactly { name, reason }",
        "Do not add fields to ProfileProblem",
      );
    });

    it("getProfile for the name throws with the higher-precedence reason (no key)", () => {
      const reason = isolatedReason(c.name, c.higherOnly);
      const set = load(c.input);
      expectConfigError(
        () => getProfile(set, c.name),
        [reason],
        [LOWER_KEY, ENV_KEY],
        `getProfile(${c.label}, "${c.name}")`,
        "Defect 2: the failed name is rejected with its reason",
        "Reject the name with the reason instead of returning the lower profile",
      );
    });

    it("a selected default (COGNIGY_PROFILE) naming it throws the unusable error with the reason", () => {
      const reason = isolatedReason(c.name, c.higherOnly);
      expectConfigError(
        () =>
          load({
            ...c.input,
            env: { ...c.input.env, ...c.selectEnv },
          }),
        [reason, "other"],
        [LOWER_KEY],
        `loadProfiles(${c.label}, COGNIGY_PROFILE=${c.name})`,
        "Defect 2: selecting a failed name is a selector error with its reason",
        "Throw the existing unusable-default error listing available names and the reason",
      );
    });

    it("a selected default (file defaultProfile) naming it throws the unusable error with the reason", () => {
      const reason = isolatedReason(c.name, c.higherOnly);
      const env = { ...c.input.env };
      delete env.COGNIGY_PROFILE;
      expectConfigError(
        () =>
          load({
            ...c.input,
            env,
            fileProfiles: {
              ...(c.input.fileProfiles as NonNullable<Input["fileProfiles"]>),
              defaultProfile: c.name,
            },
          }),
        [reason, "other"],
        [LOWER_KEY],
        `loadProfiles(${c.label}, defaultProfile=${c.name})`,
        "Defect 2: a file default naming a failed name is a selector error with its reason",
        "Throw the existing unusable-default error listing available names and the reason",
      );
    });
  });
});

const ENV_PROD_OK: Env = {
  [`${P}PROD_API_BASE_URL`]: "https://api-prod-env.cognigy.ai",
  [`${P}PROD_API_KEY`]: ENV_KEY,
};

function winnerOf(set: ProfileSet, name: string, what: string): Profile {
  const e = thrownBy(() => getProfile(set, name));
  if (e instanceof Error) {
    fail(
      what,
      "Defect 3: a usable winner is returned even when a lower source is broken",
      `getProfile returns the ${name} profile`,
      show(e),
      "Ignore problems of lower-precedence definitions for a name with a usable winner",
    );
  }
  return getProfile(set, name);
}

describe("Defect 3: a shadowed lower-precedence problem must not block a valid winner", () => {
  const UNRELATED = { name: "zzz", reason: "unrelated file problem" };

  it.each([
    [
      "file apiKey of the wrong type (reported by the file reader) + valid env prod",
      files({ other: OTHER }, [
        { name: "prod", reason: "apiKey must be a string" },
        UNRELATED,
      ]),
    ],
    [
      "file entry with an invalid URL + valid env prod",
      files(
        { prod: { apiBaseUrl: "not a url", apiKey: LOWER_KEY }, other: OTHER },
        [UNRELATED],
      ),
    ],
  ])("%s", (label, fileProfiles) => {
    const what = `loadProfiles(${label})`;
    const set = load({ env: ENV_PROD_OK, fileProfiles });
    const p = winnerOf(set, "prod", what);
    eq(
      [p.name, p.source, p.apiBaseUrl, p.apiKey],
      ["prod", "env-profile", "https://api-prod-env.cognigy.ai", ENV_KEY],
      what,
      "Defect 3: the env profile wins",
      "Return the env-profile definition",
    );
    eq(
      set.problems,
      [UNRELATED],
      what,
      "Defect 3: only problems of lower-precedence sources of 'prod' are dropped; unrelated problems stay",
      "Remove shadowed problems for the winning name and keep every other problem",
    );
  });

  it("legacy-file default broken + valid file default: the file profile wins, no problem", () => {
    const what =
      "loadProfiles(broken legacy-file default + valid file default)";
    const set = load({
      env: {},
      legacyFile: {
        COGNIGY_API_BASE_URL: "not a url",
        COGNIGY_API_KEY: LOWER_KEY,
      },
      fileProfiles: files({
        default: { apiBaseUrl: "https://api-file.cognigy.ai", apiKey: ENV_KEY },
      }),
    });
    const p = winnerOf(set, "default", what);
    eq(
      [p.source, p.apiBaseUrl, p.apiKey, set.problems],
      ["file-profile", "https://api-file.cognigy.ai", ENV_KEY, []],
      what,
      "Defect 3: file-profile outranks legacy-file; the legacy problem is shadowed",
      "Drop the legacy-file problem for 'default'",
    );
  });

  it("legacy-file default broken + valid env-profile default: the env profile wins, no problem", () => {
    const what = "loadProfiles(broken legacy-file default + valid env default)";
    const set = load({
      env: {
        [`${P}DEFAULT_API_BASE_URL`]: "https://api-envdef.cognigy.ai",
        [`${P}DEFAULT_API_KEY`]: ENV_KEY,
      },
      legacyFile: {
        COGNIGY_API_BASE_URL: "not a url",
        COGNIGY_API_KEY: LOWER_KEY,
      },
    });
    const p = winnerOf(set, "default", what);
    eq(
      [p.source, p.apiKey, set.problems],
      ["env-profile", ENV_KEY, []],
      what,
      "Defect 3: env-profile outranks legacy-file",
      "Drop the legacy-file problem for 'default'",
    );
  });

  describe("nothing usable: the reason comes from the highest failing source", () => {
    const envOnly: Input = { env: ENV_URL_ONLY("PROD") };
    const fileInvalidUrl = files({
      prod: { apiBaseUrl: "not a url", apiKey: LOWER_KEY },
    });
    const fileBadKey = files({
      default: { apiBaseUrl: "https://api-file.cognigy.ai", apiKey: 123 },
    });
    const legacyBadUrl = {
      COGNIGY_API_BASE_URL: "not a url",
      COGNIGY_API_KEY: LOWER_KEY,
    };

    it.each([
      [
        "env over file",
        "prod",
        envOnly,
        { env: {}, fileProfiles: fileInvalidUrl },
        { env: ENV_URL_ONLY("PROD"), fileProfiles: fileInvalidUrl },
      ],
      [
        "file over legacy-file",
        "default",
        { env: {}, fileProfiles: fileBadKey },
        { env: {}, legacyFile: legacyBadUrl },
        { env: {}, fileProfiles: fileBadKey, legacyFile: legacyBadUrl },
      ],
    ] as [string, string, Input, Input, Input][])(
      "%s",
      (label, name, higher, lower, both) => {
        const what = `getProfile(${label} both broken)`;
        const higherReason = isolatedReason(name, higher);
        const lowerReason = isolatedReason(name, lower);
        ok(
          higherReason !== lowerReason,
          "test setup",
          "the two failing definitions must produce distinguishable reasons",
          "different reasons",
          JSON.stringify([higherReason, lowerReason]),
          "n/a",
        );
        const set = load(both);
        ok(
          !set.profiles.some((p) => p.name === name),
          what,
          "Defect 3: no usable definition survives",
          `no profile named ${name}`,
          show(set.profiles.map((p) => p.name)),
          "Do not build a profile from a failed definition",
        );
        ok(
          reasonsFor(set, name).includes(higherReason),
          what,
          "Defect 3: problems list the highest-precedence failure",
          `a problem for ${name} with reason ${JSON.stringify(higherReason)}`,
          show(set.problems),
          "Record every failing definition, including the highest",
        );
        expectConfigError(
          () => getProfile(set, name),
          [higherReason],
          [lowerReason, LOWER_KEY],
          what,
          "Defect 3: the error reason is the highest-precedence failing source's",
          "Report the env reason over the file reason, and the file reason over the legacy one",
        );
      },
    );
  });
});
