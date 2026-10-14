/**
 * Defect A (REAL pure loader): the legacy "default" profile is `legacy-env`
 * when EITHER COGNIGY_API_BASE_URL or COGNIGY_API_KEY comes from env, and
 * `legacy-file` only when BOTH come from the legacy config file.
 *
 * Precedence for "default" (highest first):
 *   env-profile (COGNIGY_PROFILE_DEFAULT_*) > legacy-env (any field from env)
 *   > file-profile named default > legacy-file
 *
 * Documented contract: "A config-file profile named default replaces the legacy
 * flat keys from the config file, but never COGNIGY_API_* environment variables."
 */
import { describe, it } from "@jest/globals";
import { loadProfiles, type ProfileSet } from "../profiles/profiles.js";
import { eq, ok, show } from "./helpers/specAssert.js";

const ENV_URL = "https://api-legacy-env.cognigy.ai";
const FILE_URL = "https://api-legacy-file.cognigy.ai";
const ENV_KEY = "fake-key-env-aaaa";
const FILE_KEY = "fake-key-file-bbbb";
const FD_URL = "https://api-saved-default.cognigy.ai";
const FD_KEY = "fake-key-saveddef-cccc";
const P = "COGNIGY_PROFILE_";

type Env = Record<string, string | undefined>;
const SAVED_DEFAULT = { apiBaseUrl: FD_URL, apiKey: FD_KEY };

function load(
  env: Env,
  legacyFile: Record<string, string> | undefined,
  withFileDefault: boolean,
): ProfileSet {
  return loadProfiles({
    env,
    ...(legacyFile ? { legacyFile } : {}),
    fileProfiles: {
      profiles: withFileDefault ? { default: SAVED_DEFAULT } : {},
      problems: [],
    },
  } as never);
}

const view = (
  set: ProfileSet,
): {
  names: string[];
  source?: string;
  url?: string;
  key?: string;
} => {
  const d = set.profiles.find((p) => p.name === "default");
  return {
    names: set.profiles.map((p) => p.name).sort(),
    source: d?.source,
    url: d?.apiBaseUrl,
    key: d?.apiKey,
  };
};

interface MixedCase {
  label: string;
  env: Env;
  legacyFile: Record<string, string>;
  /** Expected winner when NO saved file default exists. */
  plain: { source: string; url: string; key: string };
  /** Does a saved file `default` replace the legacy definition? */
  fileDefaultReplaces: boolean;
}

const CASES: MixedCase[] = [
  {
    label: "URL from env, key from file",
    env: { COGNIGY_API_BASE_URL: ENV_URL },
    legacyFile: {
      COGNIGY_API_BASE_URL: FILE_URL,
      COGNIGY_API_KEY: FILE_KEY,
    },
    plain: { source: "legacy-env", url: ENV_URL, key: FILE_KEY },
    fileDefaultReplaces: false,
  },
  {
    label: "key from env, URL from file",
    env: { COGNIGY_API_KEY: ENV_KEY },
    legacyFile: {
      COGNIGY_API_BASE_URL: FILE_URL,
      COGNIGY_API_KEY: FILE_KEY,
    },
    plain: { source: "legacy-env", url: FILE_URL, key: ENV_KEY },
    fileDefaultReplaces: false,
  },
  {
    label: "both from env (file also has both)",
    env: { COGNIGY_API_BASE_URL: ENV_URL, COGNIGY_API_KEY: ENV_KEY },
    legacyFile: {
      COGNIGY_API_BASE_URL: FILE_URL,
      COGNIGY_API_KEY: FILE_KEY,
    },
    plain: { source: "legacy-env", url: ENV_URL, key: ENV_KEY },
    fileDefaultReplaces: false,
  },
  {
    label: "both from file",
    env: {},
    legacyFile: {
      COGNIGY_API_BASE_URL: FILE_URL,
      COGNIGY_API_KEY: FILE_KEY,
    },
    plain: { source: "legacy-file", url: FILE_URL, key: FILE_KEY },
    fileDefaultReplaces: true,
  },
  {
    label: "env values are unexpanded placeholders, so both come from file",
    env: {
      COGNIGY_API_BASE_URL: "${COGNIGY_API_BASE_URL}",
      COGNIGY_API_KEY: "${COGNIGY_API_KEY}",
    },
    legacyFile: {
      COGNIGY_API_BASE_URL: FILE_URL,
      COGNIGY_API_KEY: FILE_KEY,
    },
    plain: { source: "legacy-file", url: FILE_URL, key: FILE_KEY },
    fileDefaultReplaces: true,
  },
  {
    label: "env URL is a placeholder, env key is real, URL from file",
    env: {
      COGNIGY_API_BASE_URL: "${COGNIGY_API_BASE_URL}",
      COGNIGY_API_KEY: ENV_KEY,
    },
    legacyFile: { COGNIGY_API_BASE_URL: FILE_URL },
    plain: { source: "legacy-env", url: FILE_URL, key: ENV_KEY },
    fileDefaultReplaces: false,
  },
];

describe("Defect A: legacy default source reflects ANY environment-supplied field", () => {
  describe.each(CASES)("$label", (c) => {
    it("without a saved file default: source, per-field values and no problems", () => {
      const what = `loadProfiles(${c.label}, no file default)`;
      const set = load(c.env, c.legacyFile, false);
      eq(
        view(set),
        {
          names: ["default"],
          source: c.plain.source,
          url: c.plain.url,
          key: c.plain.key,
        },
        what,
        "Defect A: source is legacy-env if either field came from env, legacy-file only if both came from the file; each field is env-first",
        `Label the legacy default ${c.plain.source} and take every field from env when set there, otherwise from the legacy file`,
      );
      eq(
        set.problems,
        [],
        what,
        "Defect A: a valid legacy default records no problems",
        "Do not record problems for a usable definition",
      );
    });

    it(
      c.fileDefaultReplaces
        ? "a saved file default replaces it (file-only legacy), no problems"
        : "a saved file default must NOT replace it and records no problem",
      () => {
        const what = `loadProfiles(${c.label} + saved file default)`;
        const set = load(c.env, c.legacyFile, true);
        const expected = c.fileDefaultReplaces
          ? { source: "file-profile", url: FD_URL, key: FD_KEY }
          : c.plain;
        eq(
          view(set),
          {
            names: ["default"],
            source: expected.source,
            url: expected.url,
            key: expected.key,
          },
          what,
          c.fileDefaultReplaces
            ? "Defect A: a file default replaces legacy settings that came only from the config file"
            : "Defect A: a file default never replaces COGNIGY_API_* environment variables, not even one of them",
          c.fileDefaultReplaces
            ? "Let the saved profile win over a file-only legacy default"
            : "Keep the environment-backed legacy definition (including its env-supplied field) and ignore the saved profile",
        );
        eq(
          set.problems,
          [],
          what,
          "Defect A: an ignored (shadowed) file default must produce no problems",
          "Silently ignore the lower-precedence definition",
        );
      },
    );
  });
});

describe("Defect A: precedence against env-profile and invalid mixed definitions", () => {
  const ENV_DEFAULT: Env = {
    [`${P}DEFAULT_API_BASE_URL`]: "https://api-env-profile.cognigy.ai",
    [`${P}DEFAULT_API_KEY`]: "fake-key-envprofile-dddd",
  };

  it("an env-profile named default still beats a mixed legacy-env (URL env + key file)", () => {
    const set = load(
      { COGNIGY_API_BASE_URL: ENV_URL, ...ENV_DEFAULT },
      { COGNIGY_API_KEY: FILE_KEY },
      true,
    );
    eq(
      view(set),
      {
        names: ["default"],
        source: "env-profile",
        url: "https://api-env-profile.cognigy.ai",
        key: "fake-key-envprofile-dddd",
      },
      "loadProfiles(env-profile default + mixed legacy + file default)",
      "Defect A: env-profile > legacy-env regardless of how legacy-env was assembled",
      "Keep the COGNIGY_PROFILE_DEFAULT_* definition as the winner",
    );
    eq(
      set.problems,
      [],
      "loadProfiles(env-profile default + mixed legacy + file default)",
      "Defect A: shadowed lower definitions record no problems",
      "Drop lower-precedence definitions silently",
    );
  });

  it.each([
    ["without", false],
    ["with", true],
  ])(
    "invalid mixed legacy (env URL is not a URL, key from file) %s a saved file default: unusable, blocks the file default, problem recorded",
    (_l, withFileDefault) => {
      const what = `loadProfiles(invalid env URL + file key, ${_l} file default)`;
      const set = load(
        { COGNIGY_API_BASE_URL: "not a url" },
        { COGNIGY_API_KEY: FILE_KEY },
        withFileDefault,
      );
      ok(
        !set.profiles.some((p) => p.name === "default"),
        what,
        "Defect A: an unusable legacy-env definition leaves no profile named default, and the lower-precedence file default must not take its place",
        "no profile named default",
        show(set.profiles.map((p) => [p.name, p.source])),
        "Treat the environment-backed definition as the winner even though it is unusable",
      );
      ok(
        set.problems.some((p) => p.name === "default" && p.reason.length > 0),
        what,
        "Defect A: the unusable definition is reported as a problem for default",
        'a problem {name:"default"} with a non-empty reason',
        show(set.problems),
        "Record why the default definition is unusable",
      );
      ok(
        !JSON.stringify(set.problems).includes(FD_KEY),
        what,
        "Spec 0: reasons never contain key material",
        "no key in the reasons",
        "a key appeared in problems [redacted]",
        "Never put key material in a reason",
      );
    },
  );
});
