import { describe, it, expect } from "@jest/globals";
import { inspect } from "util";
import {
  ProfileConfigError,
  describeProfile,
  getProfile,
  loadProfiles,
  loadProfilesFromSystem,
  type Profile,
  type ProfileSet,
} from "../profiles/profiles.js";
import type { ProfilesFile } from "../profiles/profilesFile.js";
import { eq, ok, raises, show } from "./helpers/specAssert.js";

const KEY = "SECRET-KEY-9f8e7d6c";
const URL_DEV = "https://api-dev.cognigy.ai";
const P = "COGNIGY_PROFILE_";

type EnvMap = Record<string, string | undefined>;

/** Env settings for one env profile (NAME is the env-style uppercase name). */
function envProfile(
  name: string,
  url: string | undefined,
  key: string | undefined,
  extra: EnvMap = {},
): EnvMap {
  const out: EnvMap = {};
  if (url !== undefined) out[`${P}${name}_API_BASE_URL`] = url;
  if (key !== undefined) out[`${P}${name}_API_KEY`] = key;
  for (const [suffix, value] of Object.entries(extra))
    out[`${P}${name}_${suffix}`] = value;
  return out;
}
function fileOf(
  profiles: ProfilesFile["profiles"],
  defaultProfile?: string,
): ProfilesFile {
  return defaultProfile === undefined
    ? { profiles, problems: [] }
    : { defaultProfile, profiles, problems: [] };
}
const GOOD_ENV = envProfile("OK", "https://api-ok.cognigy.ai", "test-key-ok");

/** Reads every field by property access (apiKey may be non-enumerable). */
function snap(p: Profile): Record<string, unknown> {
  return {
    name: p.name,
    apiBaseUrl: p.apiBaseUrl,
    apiKey: p.apiKey,
    endpointBaseUrl: p.endpointBaseUrl,
    webchatBaseUrl: p.webchatBaseUrl,
    staticFilesBaseUrl: p.staticFilesBaseUrl,
    versionHint: p.versionHint,
    source: p.source,
  };
}
function snapSet(set: ProfileSet): Record<string, unknown> {
  return {
    profiles: set.profiles.map(snap),
    defaultName: set.defaultName,
    problems: set.problems,
  };
}
const EMPTY = { profiles: [], defaultName: undefined, problems: [] };
const names = (set: ProfileSet): string[] => set.profiles.map((p) => p.name);
const problemNames = (set: ProfileSet): string[] =>
  set.problems.map((p) => p.name);
function only(set: ProfileSet, name: string): Profile {
  const found = set.profiles.find((p) => p.name === name);
  if (!found)
    throw new Error(
      `test setup: profile ${name} missing; have ${names(set).join(",")}`,
    );
  return found;
}
function problemOf(set: ProfileSet, name: string): string {
  const found = set.problems.find((p) => p.name === name);
  if (!found)
    throw new Error(
      `test setup: problem ${name} missing; have ${problemNames(set).join(",")}`,
    );
  return found.reason;
}
function loadOne(url: string): Profile {
  return only(
    loadProfiles({ env: envProfile("X", url, "test-key-aaaa") }),
    "x",
  );
}
function expectConfigError(
  fn: () => unknown,
  what: string,
  why: string,
): ProfileConfigError {
  return raises(
    fn,
    ProfileConfigError,
    what,
    why,
    "Raise ProfileConfigError with a clear, secret-free message.",
  );
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
/** Asserts a per-profile problem: no throw, profile omitted, problem recorded with a non-empty key-free reason. */
function expectProblem(
  set: ProfileSet,
  name: string,
  what: string,
  why: string,
  reasonHas: string[] = [],
): void {
  ok(
    !names(set).includes(name),
    what,
    why,
    `profile "${name}" omitted from profiles`,
    `profiles: ${names(set).join(",")}`,
    "Leave broken profiles out of the usable set.",
  );
  const reason = set.problems.find((p) => p.name === name)?.reason;
  ok(
    typeof reason === "string" &&
      reason.length > 0 &&
      !reason.includes(KEY) &&
      reasonHas.every((s) => reason.includes(s)),
    what,
    why,
    `problem for "${name}" with a non-empty, key-free reason containing ${JSON.stringify(reasonHas)}`,
    `problems: ${show(set.problems)}`,
    "Record the problem with a helpful reason that never contains a key.",
  );
}

describe("Rule 1: legacy single environment", () => {
  it("env pair => profile 'default' with source legacy-env and normalised URL", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "https://trial-us.cognigy.ai/",
        COGNIGY_API_KEY: "test-key-aaaa",
      },
    });
    eq(
      snapSet(set),
      {
        profiles: [
          {
            name: "default",
            apiBaseUrl: "https://api-trial-us.cognigy.ai",
            apiKey: "test-key-aaaa",
            endpointBaseUrl: "https://endpoint-trial-us.cognigy.ai",
            webchatBaseUrl: "https://webchat-trial-us.cognigy.ai",
            staticFilesBaseUrl: "https://static-trial-us.cognigy.ai",
            source: "legacy-env",
          },
        ],
        defaultName: "default",
        problems: [],
      },
      "loadProfiles(legacy env pair)",
      "R1: env pair defines the legacy 'default' profile",
      "Build one profile named default from the legacy variables and select it as default.",
    );
  });

  it("file pair => profile 'default' with source legacy-file", () => {
    const set = loadProfiles({
      env: {},
      legacyFile: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-file",
      },
    });
    const p = only(set, "default");
    eq(
      [p.source, p.apiBaseUrl, p.apiKey, set.defaultName],
      ["legacy-file", URL_DEV, "test-key-file", "default"],
      "loadProfiles(legacy file pair)",
      "R1: file pair defines legacy 'default' when env has none",
      "Fall back to the legacy file pair.",
    );
  });

  it("env wins per field and file fills the gap: env URL + file key => legacy-file", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_BASE_URL: "https://api-env.cognigy.ai" },
      legacyFile: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-file",
      },
    });
    const p = only(set, "default");
    eq(
      [p.source, p.apiBaseUrl, p.apiKey],
      ["legacy-file", "https://api-env.cognigy.ai", "test-key-file"],
      "loadProfiles(env URL only + file pair)",
      "R1: per-field precedence; source is legacy-env only when BOTH came from env",
      "Take the URL from env, the key from the file, and label the source legacy-file.",
    );
  });

  it("env wins per field: env key + file URL => legacy-file", () => {
    const set = loadProfiles({
      env: { COGNIGY_API_KEY: "test-key-env" },
      legacyFile: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-file",
      },
    });
    const p = only(set, "default");
    eq(
      [p.source, p.apiBaseUrl, p.apiKey],
      ["legacy-file", URL_DEV, "test-key-env"],
      "loadProfiles(env key only + file pair)",
      "R1: env value wins per field",
      "Use the env key even though the file also has one.",
    );
  });

  it("env pair wins over a full file pair", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "https://api-env.cognigy.ai",
        COGNIGY_API_KEY: "test-key-env",
      },
      legacyFile: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-file",
      },
    });
    const p = only(set, "default");
    eq(
      [p.source, p.apiBaseUrl, p.apiKey],
      ["legacy-env", "https://api-env.cognigy.ai", "test-key-env"],
      "loadProfiles(env pair + file pair)",
      "R1: env wins",
      "Prefer the env pair entirely when both fields are in env.",
    );
  });

  it("neither source => no legacy profile and no problem", () => {
    eq(
      snapSet(loadProfiles({ env: {}, legacyFile: {} })),
      EMPTY,
      "loadProfiles(no legacy settings)",
      "R1: absence is not an error",
      "Return an empty set when nothing is configured.",
    );
  });
});

describe("Rule 2 and E: env profiles (scanner is case-insensitive)", () => {
  it.each([
    ["V4_STAGING", "v4-staging"],
    ["V2", "v2"],
    ["A_B_C", "a-b-c"],
    ["WEB_API", "web-api"],
  ])("NAME %s becomes profile name %s", (envName, expected) => {
    const set = loadProfiles({
      env: envProfile(envName, URL_DEV, "test-key-aaaa"),
    });
    eq(
      names(set),
      [expected],
      `loadProfiles(env profile ${envName})`,
      "R2: lowercase NAME and turn _ into -",
      "Derive profile names by lowercasing and replacing underscores with hyphens.",
    );
    eq(
      only(set, expected).source,
      "env-profile",
      `source of env profile ${envName}`,
      "R2: source env-profile",
      "Label env-defined profiles env-profile.",
    );
  });

  it("maps every optional setting and PLATFORM_VERSION to versionHint", () => {
    const set = loadProfiles({
      env: envProfile("V4", URL_DEV, "test-key-aaaa", {
        ENDPOINT_BASE_URL: "https://ep.custom.test",
        WEBCHAT_BASE_URL: "https://wc.custom.test",
        STATIC_FILES_BASE_URL: "https://st.custom.test",
        PLATFORM_VERSION: "v4",
      }),
    });
    eq(
      snap(set.profiles[0]),
      {
        name: "v4",
        apiBaseUrl: URL_DEV,
        apiKey: "test-key-aaaa",
        endpointBaseUrl: "https://ep.custom.test",
        webchatBaseUrl: "https://wc.custom.test",
        staticFilesBaseUrl: "https://st.custom.test",
        versionHint: "v4",
        source: "env-profile",
      },
      "loadProfiles(env profile with every setting)",
      "R2/R4: explicit settings win; PLATFORM_VERSION is versionHint",
      "Map each documented suffix onto its profile field.",
    );
  });

  it("matches the prefix and suffix case-insensitively (Windows keeps original case)", () => {
    const set = loadProfiles({
      env: {
        cognigy_profile_x_api_key: "test-key-aaaa",
        cognigy_profile_x_api_base_url: URL_DEV,
        Cognigy_Profile_Y_Api_Key: "test-key-bbbb",
        Cognigy_Profile_Y_Api_Base_Url: "https://api-y.cognigy.ai",
        Cognigy_Profile_Y_Platform_Version: "v3",
      },
    });
    eq(
      [
        names(set),
        only(set, "y").versionHint,
        only(set, "x").apiKey,
        only(set, "y").source,
      ],
      [["x", "y"], "v3", "test-key-aaaa", "env-profile"],
      "loadProfiles(lower/mixed-case env keys)",
      "E: scanning is case-insensitive",
      "Recognise profile settings regardless of the case of the variable name.",
    );
  });

  it("two keys with the same profile and setting but different case are a duplicate-definition problem", () => {
    const set = loadProfiles({
      env: {
        [`${P}A_B_API_BASE_URL`]: URL_DEV,
        [`${P}A_B_API_KEY`]: "test-key-aaaa",
        [`${P}a_b_API_KEY`]: "test-key-bbbb",
        ...GOOD_ENV,
      },
    });
    eq(
      names(set),
      ["ok"],
      "loadProfiles(duplicate via case)",
      "E/C: a duplicate invalidates only that profile",
      "Keep other valid profiles.",
    );
    expectProblem(
      set,
      "a-b",
      "loadProfiles(duplicate via case)",
      "E: same profile + setting twice is ambiguous",
    );
  });

  it("a profile name may itself contain a setting-like word (the trailing known suffix is the setting)", () => {
    const set = loadProfiles({
      env: {
        [`${P}X_API_KEY_API_KEY`]: "test-key-aaaa",
        [`${P}X_API_KEY_API_BASE_URL`]: URL_DEV,
      },
    });
    eq(
      names(set),
      ["x-api-key"],
      "loadProfiles(NAME containing API_KEY)",
      "R2: only the trailing known suffix is the setting",
      "Treat everything before the final known suffix as the profile name.",
    );
  });

  it("COGNIGY_PROFILE (no suffix) and unknown suffixes are not profile settings", () => {
    const set = loadProfiles({
      env: {
        PATH: "/bin",
        COGNIGY_PROFILE: "alpha",
        [`${P}FOO_TIMEOUT`]: "30",
        ...envProfile("ALPHA", URL_DEV, "test-key-aaaa"),
        ...envProfile("BETA", "https://api-beta.cognigy.ai", "test-key-bbbb"),
      },
    });
    eq(
      [names(set), set.defaultName, set.problems],
      [["alpha", "beta"], "alpha", []],
      "loadProfiles(env with COGNIGY_PROFILE selector)",
      "R2: COGNIGY_PROFILE selects the default and defines no profile",
      "Ignore unrelated variables; create profiles only from known suffixes.",
    );
  });

  it.each([
    ["URL set, key missing", envProfile("V4", URL_DEV, undefined), "API_KEY"],
    ["key set, URL missing", envProfile("V4", undefined, KEY), "API_BASE_URL"],
    ["empty API_KEY", envProfile("V4", URL_DEV, ""), "API_KEY"],
  ])(
    "half-defined env profile (%s) is a per-profile problem naming the missing setting; valid siblings survive",
    (label, env, setting) => {
      const set = loadProfiles({ env: { ...env, ...GOOD_ENV } });
      eq(
        names(set),
        ["ok"],
        `loadProfiles(${label} + valid sibling)`,
        "C: one broken profile must not discard others",
        "Keep valid profiles; do not throw.",
      );
      expectProblem(
        set,
        "v4",
        `loadProfiles(${label})`,
        "C/R2: a profile needs both API_BASE_URL and API_KEY",
        [setting],
      );
    },
  );

  it("a derived name that violates the name rule is a problem named by the raw derived text", () => {
    const set = loadProfiles({
      env: {
        [`${P}_LEAD_API_BASE_URL`]: URL_DEV,
        [`${P}_LEAD_API_KEY`]: KEY,
        ...GOOD_ENV,
      },
    });
    eq(
      names(set),
      ["ok"],
      "loadProfiles(env key deriving '-lead')",
      "C: undervivable names do not discard others",
      "Keep valid profiles.",
    );
    ok(
      set.problems.some(
        (p) =>
          (p.name === "-lead" || p.name === "_LEAD") &&
          p.reason.length > 0 &&
          !p.reason.includes(KEY),
      ),
      "loadProfiles(env key deriving '-lead')",
      "C: problem named by the raw derived text",
      'a key-free problem named "-lead" (or "_LEAD")',
      show(set.problems),
      "Report the offending name instead of throwing.",
    );
  });
});

describe("Rule 3 and C: file profiles", () => {
  it("builds profiles from the file with source file-profile and all optional fields", () => {
    const set = loadProfiles({
      env: {},
      fileProfiles: fileOf({
        "v4-staging": {
          apiBaseUrl: URL_DEV,
          apiKey: "test-key-aaaa",
          endpointBaseUrl: "https://ep.custom.test",
          webchatBaseUrl: "https://wc.custom.test",
          staticFilesBaseUrl: "https://st.custom.test",
          versionHint: "v4",
        },
      }),
    });
    eq(
      set.profiles.map(snap),
      [
        {
          name: "v4-staging",
          apiBaseUrl: URL_DEV,
          apiKey: "test-key-aaaa",
          endpointBaseUrl: "https://ep.custom.test",
          webchatBaseUrl: "https://wc.custom.test",
          staticFilesBaseUrl: "https://st.custom.test",
          versionHint: "v4",
          source: "file-profile",
        },
      ],
      "loadProfiles(file profile)",
      "R3: file profiles map field-for-field",
      "Map each file field onto the profile and label the source file-profile.",
    );
  });

  it.each([["a"], ["0x"], ["v4-staging"], ["a1-b2-c3"]])(
    "accepts valid name %j",
    (name) => {
      const set = loadProfiles({
        env: {},
        fileProfiles: fileOf({
          [name]: { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa" },
        }),
      });
      eq(
        names(set),
        [name],
        `loadProfiles(file profile ${name})`,
        "R3: name rule accepts it",
        "Keep valid names unchanged.",
      );
    },
  );

  it.each([["UPPER"], ["-lead"], ["has space"], ["under_score"], ["dot.name"]])(
    "invalid file profile name %j is a problem named by it; valid siblings survive",
    (name) => {
      const set = loadProfiles({
        env: {},
        fileProfiles: fileOf({
          [name]: { apiBaseUrl: URL_DEV, apiKey: KEY },
          good: { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa" },
        }),
      });
      eq(
        names(set),
        ["good"],
        `loadProfiles(file profile named ${JSON.stringify(name)})`,
        "C: one bad name must not discard others",
        "Keep valid profiles.",
      );
      expectProblem(
        set,
        name,
        `loadProfiles(file profile named ${JSON.stringify(name)})`,
        "R3: names must match /^[a-z0-9][a-z0-9-]*$/",
      );
    },
  );

  it("a file profile with a placeholder apiKey is a problem for that profile", () => {
    const set = loadProfiles({
      env: {},
      fileProfiles: fileOf({
        dev: { apiBaseUrl: URL_DEV, apiKey: "${COGNIGY_KEY}" },
        good: { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa" },
      }),
    });
    eq(
      names(set),
      ["good"],
      "loadProfiles(file profile with placeholder apiKey)",
      "C/R7: placeholder is unset => profile broken",
      "Keep valid siblings.",
    );
    expectProblem(
      set,
      "dev",
      "loadProfiles(file profile with placeholder apiKey)",
      "R7: placeholders are unset",
    );
  });

  it.each([
    ["numeric apiKey", { apiBaseUrl: URL_DEV, apiKey: 123 }],
    [
      "numeric versionHint",
      { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa", versionHint: 4 },
    ],
    [
      "object endpointBaseUrl",
      { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa", endpointBaseUrl: {} },
    ],
  ])("file profile with %s is a problem, not a throw", (label, bad) => {
    const set = loadProfiles({
      env: {},
      fileProfiles: {
        profiles: {
          bad,
          good: { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa" },
        },
        problems: [],
      } as unknown as ProfilesFile,
    });
    eq(
      names(set),
      ["good"],
      `loadProfiles(file profile with ${label})`,
      "C: wrong field type breaks only that profile",
      "Keep valid siblings.",
    );
    expectProblem(
      set,
      "bad",
      `loadProfiles(file profile with ${label})`,
      "C: wrong field type",
    );
  });

  it("merges problems reported by the file reader into ProfileSet.problems", () => {
    const set = loadProfiles({
      env: {},
      fileProfiles: {
        profiles: { good: { apiBaseUrl: URL_DEV, apiKey: "test-key-aaaa" } },
        problems: [{ name: "broken", reason: "reader-reason-xyz" }],
      },
    });
    ok(
      names(set).join() === "good" &&
        set.problems.some(
          (p) => p.name === "broken" && p.reason.includes("reader-reason-xyz"),
        ),
      "loadProfiles(fileProfiles.problems)",
      "G: reader problems are merged",
      'profiles ["good"], problem "broken" with the reader reason',
      show({ names: names(set), problems: set.problems }),
      "Surface file-reader problems in the profile set.",
    );
    const err = expectConfigError(
      () => getProfile(set, "broken"),
      "getProfile(set, 'broken')",
      "G/C: broken names explain themselves",
    );
    expect(err.message).toContain("reader-reason-xyz");
  });
});

describe("Rule 4: host derivation", () => {
  it.each([
    [
      "https://trial-us.cognigy.ai",
      "https://api-trial-us.cognigy.ai",
      "https://endpoint-trial-us.cognigy.ai",
      "https://webchat-trial-us.cognigy.ai",
      "https://static-trial-us.cognigy.ai",
    ],
    [
      "https://api-dev.cognigy.ai/",
      "https://api-dev.cognigy.ai",
      "https://endpoint-dev.cognigy.ai",
      "https://webchat-dev.cognigy.ai",
      "https://static-dev.cognigy.ai",
    ],
    [
      "https://api-eu.cognigy.ai///",
      "https://api-eu.cognigy.ai",
      "https://endpoint-eu.cognigy.ai",
      "https://webchat-eu.cognigy.ai",
      "https://static-eu.cognigy.ai",
    ],
    [
      "https://cognigy-api-na1.nicecxone.com",
      "https://cognigy-api-na1.nicecxone.com",
      "https://cognigy-endpoint-na1.nicecxone.com",
      "https://cognigy-webchat-na1.nicecxone.com",
      "https://cognigy-static-na1.nicecxone.com",
    ],
    [
      "https://api.test",
      "https://api.test",
      "https://endpoint.test",
      "https://webchat.test",
      "https://static.test",
    ],
    [
      "http://api.test:8080",
      "http://api.test:8080",
      "http://endpoint.test:8080",
      "http://webchat.test:8080",
      "http://static.test:8080",
    ],
    [
      "https://cognigy.example.org",
      "https://cognigy.example.org",
      "https://cognigy.example.org",
      "https://cognigy.example.org",
      "https://cognigy.example.org",
    ],
  ])("derives from %s", (input, api, endpoint, webchat, statics) => {
    const p = loadOne(input);
    eq(
      [p.apiBaseUrl, p.endpointBaseUrl, p.webchatBaseUrl, p.staticFilesBaseUrl],
      [api, endpoint, webchat, statics],
      `host derivation for ${input}`,
      "R4: api- prefix for *.cognigy.ai, trailing slashes stripped, sibling hosts by swapping the api word, port preserved",
      "Derive the API host and sibling hosts exactly as the single-environment plugin does.",
    );
  });

  it("explicit *_BASE_URL settings win over derivation, other siblings still derive", () => {
    const p = only(
      loadProfiles({
        env: envProfile("X", URL_DEV, "test-key-aaaa", {
          WEBCHAT_BASE_URL: "https://chat.custom.test",
        }),
      }),
      "x",
    );
    eq(
      [p.endpointBaseUrl, p.webchatBaseUrl, p.staticFilesBaseUrl],
      [
        "https://endpoint-dev.cognigy.ai",
        "https://chat.custom.test",
        "https://static-dev.cognigy.ai",
      ],
      "explicit webchat override",
      "R4: explicit settings win; the rest derive",
      "Override only the siblings that are set.",
    );
  });
});

describe("Rule F: URL scheme", () => {
  it("accepts http for local clusters", () => {
    const set = loadProfiles({
      env: envProfile("LOCAL", "http://localhost:8080", "test-key-aaaa"),
    });
    eq(
      [names(set), set.problems],
      [["local"], []],
      "loadProfiles(http URL)",
      "F: http: and https: are allowed",
      "Accept http URLs.",
    );
  });

  it.each([
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
    ["ftp://api.test"],
  ])("API URL %s is a per-profile problem", (url) => {
    const set = loadProfiles({
      env: { ...envProfile("BAD", url, KEY), ...GOOD_ENV },
    });
    eq(
      names(set),
      ["ok"],
      `loadProfiles(API URL ${url})`,
      "F: only http/https; others break only that profile",
      "Keep valid siblings.",
    );
    expectProblem(
      set,
      "bad",
      `loadProfiles(API URL ${url})`,
      "F: scheme must be http: or https:",
    );
  });

  it.each([["file:///x"], ["javascript:alert(1)"], ["ftp://ep.test"]])(
    "explicit sibling URL %s is a per-profile problem",
    (url) => {
      const set = loadProfiles({
        env: {
          ...envProfile("BAD", URL_DEV, KEY, { WEBCHAT_BASE_URL: url }),
          ...GOOD_ENV,
        },
      });
      eq(
        names(set),
        ["ok"],
        `loadProfiles(WEBCHAT_BASE_URL ${url})`,
        "F: sibling URLs follow the same scheme rule",
        "Keep valid siblings.",
      );
      expectProblem(
        set,
        "bad",
        `loadProfiles(WEBCHAT_BASE_URL ${url})`,
        "F: scheme must be http: or https:",
      );
    },
  );

  it("describeProfile never throws and reports (invalid) for unparsable URLs", () => {
    const base: Profile = {
      name: "dev",
      apiBaseUrl: "not a url",
      apiKey: KEY,
      endpointBaseUrl: "also not a url",
      webchatBaseUrl: "x",
      staticFilesBaseUrl: "x",
      source: "env-profile",
    };
    const d = JSON.parse(JSON.stringify(describeProfile(base)));
    eq(
      [d.apiHost, d.endpointHost],
      ["(invalid)", "(invalid)"],
      "describeProfile(profile with unparsable URLs)",
      "F: describeProfile never throws",
      "Return the placeholder host (invalid) instead of throwing.",
    );
    const d2 = JSON.parse(
      JSON.stringify(describeProfile({ ...base, apiBaseUrl: URL_DEV })),
    );
    eq(
      [d2.apiHost, d2.endpointHost],
      ["api-dev.cognigy.ai", "(invalid)"],
      "describeProfile(valid API, invalid endpoint)",
      "F: each host is independent",
      "Only the unparsable host becomes (invalid).",
    );
  });
});

describe("Rules 5, D and C: precedence, normalisation and default selection", () => {
  it("env definition replaces a same-named file profile entirely (no field mixing)", () => {
    const set = loadProfiles({
      env: envProfile("DEV", "https://api-env.cognigy.ai", "test-key-env"),
      fileProfiles: fileOf({
        dev: {
          apiBaseUrl: URL_DEV,
          apiKey: "test-key-file",
          webchatBaseUrl: "https://wc.file.test",
          versionHint: "v3",
        },
      }),
    });
    eq(
      set.profiles.map(snap),
      [
        {
          name: "dev",
          apiBaseUrl: "https://api-env.cognigy.ai",
          apiKey: "test-key-env",
          endpointBaseUrl: "https://endpoint-env.cognigy.ai",
          webchatBaseUrl: "https://webchat-env.cognigy.ai",
          staticFilesBaseUrl: "https://static-env.cognigy.ai",
          source: "env-profile",
        },
      ],
      "loadProfiles(same name in env and file)",
      "R5: env replaces file ENTIRELY",
      "Drop every file field (webchat override, versionHint) when env defines the profile.",
    );
  });

  it("names collide after normalisation: env A_B replaces file a-b", () => {
    const set = loadProfiles({
      env: envProfile("A_B", "https://api-env.cognigy.ai", "test-key-env"),
      fileProfiles: fileOf({
        "a-b": { apiBaseUrl: URL_DEV, apiKey: "test-key-file" },
      }),
    });
    eq(
      [names(set), only(set, "a-b").source, only(set, "a-b").apiKey],
      [["a-b"], "env-profile", "test-key-env"],
      "loadProfiles(env A_B + file a-b)",
      "D: compare after normalisation",
      "Treat A_B and a-b as the same profile; env wins.",
    );
  });

  it("an env profile named 'default' replaces legacy-env and a file default", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
        COGNIGY_API_KEY: "test-key-legacy",
        ...envProfile("DEFAULT", URL_DEV, "test-key-profile"),
      },
      fileProfiles: fileOf({
        default: {
          apiBaseUrl: "https://api-file.cognigy.ai",
          apiKey: "test-key-filedefault",
        },
      }),
    });
    eq(
      [names(set), only(set, "default").source, only(set, "default").apiKey],
      [["default"], "env-profile", "test-key-profile"],
      "loadProfiles(legacy-env + file default + env default)",
      "D: env-profile default replaces everything",
      "Keep a single profile named default: the env-defined one.",
    );
  });

  it("legacy-env WINS over a file profile named 'default'", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
        COGNIGY_API_KEY: "test-key-legacy",
      },
      fileProfiles: fileOf({
        default: { apiBaseUrl: URL_DEV, apiKey: "test-key-profile" },
      }),
    });
    eq(
      [
        names(set),
        only(set, "default").source,
        only(set, "default").apiKey,
        only(set, "default").apiBaseUrl,
      ],
      [
        ["default"],
        "legacy-env",
        "test-key-legacy",
        "https://api-legacy.cognigy.ai",
      ],
      "loadProfiles(legacy env pair + file default)",
      "D: today's single-environment env vars keep winning",
      "Prefer the legacy env pair over a file profile named default.",
    );
  });

  it.each([
    [
      "legacy-file pair",
      {},
      {
        COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai",
        COGNIGY_API_KEY: "test-key-legacy",
      },
    ],
    [
      "mixed legacy (env URL + file key, source legacy-file)",
      { COGNIGY_API_BASE_URL: "https://api-legacy.cognigy.ai" },
      { COGNIGY_API_KEY: "test-key-legacy" },
    ],
  ])(
    "a file profile named 'default' replaces %s",
    (_label, env, legacyFile) => {
      const set = loadProfiles({
        env,
        legacyFile,
        fileProfiles: fileOf({
          default: { apiBaseUrl: URL_DEV, apiKey: "test-key-profile" },
        }),
      });
      eq(
        [names(set), only(set, "default").source, only(set, "default").apiKey],
        [["default"], "file-profile", "test-key-profile"],
        `loadProfiles(${_label} + file default)`,
        "D: a file default replaces legacy-file only",
        "Let the file profile replace file-sourced legacy settings.",
      );
    },
  );

  const A = { apiBaseUrl: "https://api-a.cognigy.ai", apiKey: "test-key-a" };
  const B = { apiBaseUrl: "https://api-b.cognigy.ai", apiKey: "test-key-b" };
  const D = { apiBaseUrl: "https://api-d.cognigy.ai", apiKey: "test-key-d" };
  const PROD = {
    apiBaseUrl: "https://api-prod.cognigy.ai",
    apiKey: "test-key-prod",
  };
  it.each<[string, EnvMap, ProfilesFile, string | undefined]>([
    [
      "env COGNIGY_PROFILE beats file defaultProfile",
      { COGNIGY_PROFILE: "b" },
      fileOf({ a: A, b: B, default: D }, "a"),
      "b",
    ],
    [
      "env COGNIGY_PROFILE is trimmed",
      { COGNIGY_PROFILE: "  b  " },
      fileOf({ a: A, b: B }),
      "b",
    ],
    [
      "env COGNIGY_PROFILE 'Prod' is normalised",
      { COGNIGY_PROFILE: "Prod" },
      fileOf({ a: A, prod: PROD }),
      "prod",
    ],
    [
      "env COGNIGY_PROFILE 'V4_STAGING' is normalised",
      { COGNIGY_PROFILE: "V4_STAGING" },
      fileOf({ a: A, "v4-staging": B }),
      "v4-staging",
    ],
    [
      "file defaultProfile 'Prod' is normalised",
      {},
      fileOf({ a: A, prod: PROD }, "Prod"),
      "prod",
    ],
    [
      "file defaultProfile 'V4_STAGING' is normalised",
      {},
      fileOf({ a: A, "v4-staging": B }, "V4_STAGING"),
      "v4-staging",
    ],
    [
      "file defaultProfile beats a profile named default",
      {},
      fileOf({ a: A, b: B, default: D }, "a"),
      "a",
    ],
    [
      "profile named default beats the only-one rule",
      {},
      fileOf({ a: A, default: D }),
      "default",
    ],
    ["the only profile is the default", {}, fileOf({ solo: A }), "solo"],
    [
      "two profiles and nothing selecting => undefined",
      {},
      fileOf({ a: A, b: B }),
      undefined,
    ],
    [
      "empty COGNIGY_PROFILE counts as unset",
      { COGNIGY_PROFILE: "" },
      fileOf({ solo: A }),
      "solo",
    ],
    [
      "placeholder COGNIGY_PROFILE counts as unset",
      { COGNIGY_PROFILE: "${COGNIGY_PROFILE}" },
      fileOf({ a: A, b: B }, "b"),
      "b",
    ],
    [
      "placeholder defaultProfile counts as unset",
      {},
      fileOf({ a: A, b: B }, "${defaultProfile}"),
      undefined,
    ],
    [
      "a broken profile is ignored: valid + broken => the valid one is the only profile",
      {},
      fileOf({ a: A, "BAD NAME": B }),
      "a",
    ],
    [
      "a broken 'default' is ignored: two valid, none selected => undefined",
      {},
      fileOf({ a: A, b: B, default: { apiBaseUrl: "not a url", apiKey: "k" } }),
      undefined,
    ],
  ])("default selection: %s", (label, env, fileProfiles, expected) => {
    const set = loadProfiles({ env, fileProfiles });
    eq(
      set.defaultName,
      expected,
      `defaultName for: ${label}`,
      "R5/D/C: env COGNIGY_PROFILE, file defaultProfile, 'default', only profile, else undefined; selectors normalised; broken profiles ignored",
      "Follow the documented default selection order.",
    );
  });

  it("all profiles broken => empty profiles, no default, problems recorded, no throw", () => {
    const set = loadProfiles({
      env: {},
      fileProfiles: fileOf({ x: { apiBaseUrl: "not a url", apiKey: "k" } }),
    });
    eq(
      [names(set), set.defaultName, problemNames(set)],
      [[], undefined, ["x"]],
      "loadProfiles(only broken profiles)",
      "C: broken profiles never throw",
      "Report problems and select nothing.",
    );
  });

  it("problems are sorted by name ascending", () => {
    const set = loadProfiles({
      env: {},
      fileProfiles: fileOf({
        "z-bad": { apiBaseUrl: "nope", apiKey: "k" },
        "a-bad": { apiBaseUrl: "nope", apiKey: "k" },
        "m-bad": { apiBaseUrl: "nope", apiKey: "k" },
      }),
    });
    eq(
      problemNames(set),
      ["a-bad", "m-bad", "z-bad"],
      "problem order",
      "C: problems sorted by name",
      "Return problems alphabetically.",
    );
  });

  it("a legacy profile plus one other profile defaults to 'default'", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-legacy",
      },
      fileProfiles: fileOf({ other: A }),
    });
    eq(
      set.defaultName,
      "default",
      "defaultName with legacy + another profile",
      "R5: 'default' beats only-one",
      "Prefer the profile named default.",
    );
  });

  it.each<[string, EnvMap, ProfilesFile]>([
    [
      "env COGNIGY_PROFILE names a missing profile",
      { COGNIGY_PROFILE: "nope" },
      fileOf({ alpha: { ...A, apiKey: KEY }, beta: B }),
    ],
    [
      "file defaultProfile names a missing profile",
      {},
      fileOf({ alpha: { ...A, apiKey: KEY }, beta: B }, "nope"),
    ],
  ])(
    "%s => ProfileConfigError listing available names only",
    (label, env, fileProfiles) => {
      const err = expectConfigError(
        () => loadProfiles({ env, fileProfiles }),
        `loadProfiles(${label})`,
        "R5: a selected default must exist",
      );
      ok(
        err.message.includes("alpha") &&
          err.message.includes("beta") &&
          !err.message.includes(KEY) &&
          !err.message.includes("api-a.cognigy.ai"),
        `error message: ${label}`,
        "R5/R8: list names, not keys or URLs",
        'mentions "alpha" and "beta", no key, no URL',
        JSON.stringify(err.message),
        "List the profile names the user can choose from.",
      );
    },
  );

  it.each([
    ["env COGNIGY_PROFILE", { COGNIGY_PROFILE: "bad" }, undefined],
    ["file defaultProfile", {}, "bad"],
  ])(
    "a selected default (%s) that is BROKEN throws, listing available names and the reason",
    (_label, selectorEnv, selectorFile) => {
      const files = {
        bad: { apiBaseUrl: "not a url", apiKey: KEY },
        good: { apiBaseUrl: URL_DEV, apiKey: "test-key-g" },
      };
      const reason = problemOf(
        loadProfiles({ env: {}, fileProfiles: fileOf(files) }),
        "bad",
      );
      const err = expectConfigError(
        () =>
          loadProfiles({
            env: selectorEnv,
            fileProfiles: fileOf(files, selectorFile),
          }),
        `loadProfiles(broken selected default via ${_label})`,
        "C: selecting a broken default is a selector error",
      );
      ok(
        err.message.includes("good") &&
          err.message.includes(reason) &&
          !err.message.includes(KEY),
        `error message for broken default via ${_label}`,
        "C: list available names and the broken profile's reason",
        `mentions "good" and the reason ${JSON.stringify(reason)}; no key`,
        JSON.stringify(err.message),
        "Explain why the selected profile is unusable.",
      );
    },
  );
});

describe("Rule D: duplicate-definition messages", () => {
  it("A_B and A-B collide after normalisation and the problem names both spellings", () => {
    const set = loadProfiles({
      env: {
        [`${P}A_B_API_BASE_URL`]: URL_DEV,
        [`${P}A_B_API_KEY`]: "test-key-aaaa",
        [`${P}A-B_API_KEY`]: "test-key-bbbb",
        ...GOOD_ENV,
      },
    });
    eq(
      names(set),
      ["ok"],
      "loadProfiles(A_B vs A-B)",
      "D/C: collision breaks only that profile",
      "Keep valid siblings.",
    );
    const reason = problemOf(set, "a-b");
    ok(
      /collide/i.test(reason) &&
        /normali[sz]/i.test(reason) &&
        reason.includes("A_B") &&
        reason.includes("A-B") &&
        !/differ only by case/i.test(reason),
      "loadProfiles(A_B vs A-B) problem reason",
      "D: say the names collide after normalisation and name both spellings",
      'mentions "collide", normalisation, "A_B" and "A-B", not "differ only by case"',
      JSON.stringify(reason),
      "Explain the collision precisely.",
    );
  });
});

describe("Rule 6: getProfile", () => {
  const set = loadProfiles({
    env: {},
    fileProfiles: fileOf(
      {
        alpha: { apiBaseUrl: "https://api-a.cognigy.ai", apiKey: KEY },
        beta: { apiBaseUrl: "https://api-b.cognigy.ai", apiKey: "test-key-b" },
        broken: { apiBaseUrl: "not a url", apiKey: KEY },
      },
      "beta",
    ),
  });
  const noDefault: ProfileSet = loadProfiles({
    env: {},
    fileProfiles: fileOf({
      alpha: { apiBaseUrl: "https://api-a.cognigy.ai", apiKey: KEY },
      beta: { apiBaseUrl: "https://api-b.cognigy.ai", apiKey: "test-key-b" },
    }),
  });

  it("returns the named profile", () => {
    eq(
      getProfile(set, "alpha").name,
      "alpha",
      "getProfile(set, 'alpha')",
      "R6: by name",
      "Return the requested profile.",
    );
  });

  it("returns the default profile when name is omitted", () => {
    eq(
      getProfile(set).name,
      "beta",
      "getProfile(set)",
      "R6: name omitted => default",
      "Return the default profile.",
    );
  });

  it("unknown name => ProfileConfigError listing available names, no keys/URLs", () => {
    const err = expectConfigError(
      () => getProfile(set, "nope"),
      "getProfile(set, 'nope')",
      "R6: unknown name",
    );
    ok(
      err.message.includes("alpha") &&
        err.message.includes("beta") &&
        !err.message.includes(KEY) &&
        !err.message.includes("api-a"),
      "getProfile unknown-name message",
      "R6/R8: list names only",
      'mentions "alpha" and "beta", no key, no URL',
      JSON.stringify(err.message),
      "Show the user the valid environment names.",
    );
  });

  it("a broken name => ProfileConfigError containing that profile's reason", () => {
    const reason = problemOf(set, "broken");
    const err = expectConfigError(
      () => getProfile(set, "broken"),
      "getProfile(set, 'broken')",
      "C: broken profiles explain themselves",
    );
    ok(
      err.message.includes(reason) && !err.message.includes(KEY),
      "getProfile broken-name message",
      "C: include the recorded reason, never the key",
      `contains ${JSON.stringify(reason)}`,
      JSON.stringify(err.message),
      "Tell the user why this environment is unusable.",
    );
  });

  it("no default and no name => ProfileConfigError telling the caller to pass an environment name and listing names", () => {
    const err = expectConfigError(
      () => getProfile(noDefault),
      "getProfile(set without default)",
      "R6: ambiguous default",
    );
    ok(
      /environment/i.test(err.message) &&
        err.message.includes("alpha") &&
        err.message.includes("beta") &&
        !err.message.includes(KEY),
      "getProfile no-default message",
      "R6: say to pass an environment name and list the names",
      'mentions "environment", "alpha", "beta"; no key',
      JSON.stringify(err.message),
      "Ask the caller to specify which environment to use.",
    );
  });

  it("empty set => ProfileConfigError saying no environment is configured (with or without a name)", () => {
    const empty: ProfileSet = {
      profiles: [],
      defaultName: undefined,
      problems: [],
    };
    for (const name of [undefined, "dev"]) {
      const err = expectConfigError(
        () => getProfile(empty, name),
        `getProfile(empty, ${String(name)})`,
        "R6: nothing configured",
      );
      ok(
        /no environment/i.test(err.message),
        `getProfile(empty, ${String(name)}) message`,
        "R6: say that no environment is configured",
        'message contains "no environment"',
        JSON.stringify(err.message),
        "Tell the user that no environment is configured yet.",
      );
    }
  });
});

describe("Rule 7: unexpanded placeholders are unset", () => {
  it.each([
    ["${COGNIGY_API_KEY}"],
    ["  ${COGNIGY_API_KEY}  "],
    ["${user_config.api_key}"],
    ["${}"],
  ])(
    "legacy env key %j is treated as unset (file fills it, source legacy-file)",
    (placeholder) => {
      const set = loadProfiles({
        env: { COGNIGY_API_BASE_URL: URL_DEV, COGNIGY_API_KEY: placeholder },
        legacyFile: { COGNIGY_API_KEY: "test-key-file" },
      });
      const p = only(set, "default");
      eq(
        [p.apiKey, p.source],
        ["test-key-file", "legacy-file"],
        `legacy env key ${JSON.stringify(placeholder)}`,
        "R7: an entirely ${...} value is unset",
        "Ignore placeholders so the file value is used.",
      );
    },
  );

  it("placeholders for the whole legacy pair mean no legacy profile", () => {
    eq(
      snapSet(
        loadProfiles({
          env: { COGNIGY_API_BASE_URL: "${URL}", COGNIGY_API_KEY: "${KEY}" },
        }),
      ),
      EMPTY,
      "loadProfiles(placeholder legacy pair)",
      "R7: placeholders are unset",
      "Do not create a profile from placeholder text.",
    );
  });

  it("a placeholder env profile URL with a real key is a per-profile problem naming the profile", () => {
    const set = loadProfiles({
      env: { ...envProfile("V4", "${V4_URL}", KEY), ...GOOD_ENV },
    });
    eq(
      names(set),
      ["ok"],
      "loadProfiles(placeholder URL)",
      "R7/C: placeholder in a required field breaks only that profile",
      "Keep valid siblings.",
    );
    expectProblem(
      set,
      "v4",
      "loadProfiles(placeholder URL)",
      "R7: placeholder = unset => missing API_BASE_URL",
      ["API_BASE_URL"],
    );
  });

  it("a placeholder optional setting falls back to derivation", () => {
    const p = only(
      loadProfiles({
        env: envProfile("X", URL_DEV, "test-key-aaaa", {
          ENDPOINT_BASE_URL: "${EP}",
        }),
      }),
      "x",
    );
    eq(
      p.endpointBaseUrl,
      "https://endpoint-dev.cognigy.ai",
      "placeholder ENDPOINT_BASE_URL",
      "R7: unset => derive",
      "Derive the endpoint host.",
    );
  });

  it("a value that merely contains ${...} is NOT a placeholder", () => {
    const p = only(
      loadProfiles({ env: envProfile("X", URL_DEV, "abc${X}") }),
      "x",
    );
    eq(
      p.apiKey,
      "abc${X}",
      "key containing a partial placeholder",
      "R7: only ENTIRELY-placeholder values are unset",
      "Keep values that are not wholly a placeholder.",
    );
  });
});

describe("Rule 8 and A: secrecy and key exposure", () => {
  it("no problem reason and no thrown error leaks the API key", () => {
    const scenarios: Array<[string, ProfileSet]> = [
      ["missing URL", loadProfiles({ env: envProfile("V4", undefined, KEY) })],
      [
        "invalid URL",
        loadProfiles({ env: envProfile("V4", "not a url", KEY) }),
      ],
      [
        "bad scheme",
        loadProfiles({ env: envProfile("V4", "ftp://x.test", KEY) }),
      ],
      [
        "invalid file name",
        loadProfiles({
          env: {},
          fileProfiles: fileOf({ BAD: { apiBaseUrl: URL_DEV, apiKey: KEY } }),
        }),
      ],
      [
        "invalid file URL",
        loadProfiles({
          env: {},
          fileProfiles: fileOf({ dev: { apiBaseUrl: "::::", apiKey: KEY } }),
        }),
      ],
      [
        "duplicate",
        loadProfiles({
          env: {
            [`${P}A_B_API_KEY`]: KEY,
            [`${P}a_b_API_KEY`]: KEY,
            [`${P}A_B_API_BASE_URL`]: URL_DEV,
          },
        }),
      ],
    ];
    for (const [label, set] of scenarios) {
      ok(
        set.problems.length > 0 &&
          !show(set.problems).includes(KEY) &&
          !JSON.stringify(set).includes(KEY),
        `problems for ${label}`,
        "R8: reasons never contain a key",
        "problems present, no key anywhere",
        show(set.problems),
        "Never interpolate key values into reasons.",
      );
      for (const problem of set.problems) {
        const err = expectConfigError(
          () => getProfile(set, problem.name),
          `getProfile(set, ${problem.name}) [${label}]`,
          "C: broken profile lookups throw",
        );
        ok(
          !err.message.includes(KEY),
          `getProfile error for ${label}`,
          "R8: no key in messages",
          "message without the key",
          JSON.stringify(err.message),
          "Never interpolate key values into messages.",
        );
      }
    }
    const throwing: Array<[string, () => unknown]> = [
      [
        "unknown default (env)",
        () =>
          loadProfiles({
            env: { COGNIGY_PROFILE: "zzz", ...envProfile("DEV", URL_DEV, KEY) },
          }),
      ],
      [
        "unknown default (file)",
        () =>
          loadProfiles({
            env: {},
            fileProfiles: fileOf(
              { dev: { apiBaseUrl: URL_DEV, apiKey: KEY } },
              "zzz",
            ),
          }),
      ],
      [
        "getProfile unknown",
        () =>
          getProfile(
            loadProfiles({ env: envProfile("DEV", URL_DEV, KEY) }),
            "zzz",
          ),
      ],
      [
        "getProfile no default",
        () =>
          getProfile(
            loadProfiles({
              env: {
                ...envProfile("A", URL_DEV, KEY),
                ...envProfile("B", URL_DEV, KEY),
              },
            }),
          ),
      ],
    ];
    for (const [label, fn] of throwing) {
      const err = expectConfigError(
        fn,
        `error path: ${label}`,
        "R8: failures are ProfileConfigErrors",
      );
      ok(
        !err.message.includes(KEY),
        `error path: ${label}`,
        "R8: no key in messages",
        "message without the key",
        JSON.stringify(err.message),
        "Never interpolate key values into messages.",
      );
    }
  });

  it("apiKey is readable, but JSON, String and util.inspect of profiles, sets and errors never contain it", () => {
    const set = loadProfiles({ env: envProfile("DEV", URL_DEV, KEY) });
    const profile = only(set, "dev");
    const err = expectConfigError(
      () => getProfile(set, "nope"),
      "getProfile(set, 'nope')",
      "A: errors are safe to print",
    );
    eq(
      profile.apiKey,
      KEY,
      "profile.apiKey",
      "A: reading .apiKey still works",
      "Keep apiKey readable as a property.",
    );
    const outputs: Array<[string, string]> = [
      ["JSON.stringify(profile)", JSON.stringify(profile)],
      ["JSON.stringify(profileSet)", JSON.stringify(set)],
      ["String(profile)", String(profile)],
      ["util.inspect(profile)", inspect(profile, { depth: null })],
      ["util.inspect(profileSet)", inspect(set, { depth: null })],
      ["util.inspect(error)", inspect(err, { depth: null })],
      [
        "util.inspect(error, showHidden)",
        inspect(err, { depth: null, showHidden: true }),
      ],
    ];
    for (const [label, text] of outputs) {
      ok(
        !text.includes(KEY),
        label,
        "A: accidental serialisation must not leak the key",
        "output without the key",
        `${label} contained the key`,
        "Hide apiKey from serialisation and inspection.",
      );
    }
  });

  it("ProfileConfigError carries name 'ProfileConfigError' and is an Error", () => {
    const err = expectConfigError(
      () => getProfile({ profiles: [], defaultName: undefined, problems: [] }),
      "getProfile(empty)",
      "A: error identity",
    );
    eq(
      [err.name, err instanceof Error],
      ["ProfileConfigError", true],
      "ProfileConfigError identity",
      "A: name must be set",
      "Set the error name to ProfileConfigError.",
    );
  });

  it("describeProfile returns exactly name, hosts, source and versionHint, never the key or paths", () => {
    const profile: Profile = {
      name: "dev",
      apiBaseUrl: "https://api-dev.cognigy.ai",
      apiKey: KEY,
      endpointBaseUrl: "https://endpoint-dev.cognigy.ai",
      webchatBaseUrl: "https://webchat-dev.cognigy.ai",
      staticFilesBaseUrl: "https://static-dev.cognigy.ai",
      versionHint: "v4",
      source: "file-profile",
    };
    const described = describeProfile(profile);
    eq(
      JSON.parse(JSON.stringify(described)),
      {
        name: "dev",
        apiHost: "api-dev.cognigy.ai",
        endpointHost: "endpoint-dev.cognigy.ai",
        source: "file-profile",
        versionHint: "v4",
      },
      "describeProfile(profile)",
      "R8: only safe descriptive fields (hosts, not URLs)",
      "Return hosts without scheme or path and omit every secret.",
    );
    ok(
      !JSON.stringify(described).includes(KEY),
      "describeProfile output",
      "R8: no key in describe output",
      "no key",
      "key present",
      "Never include apiKey.",
    );
  });

  it("describeProfile omits versionHint when the profile has none", () => {
    const described = describeProfile({
      name: "dev",
      apiBaseUrl: "https://api-dev.cognigy.ai",
      apiKey: KEY,
      endpointBaseUrl: "https://endpoint-dev.cognigy.ai",
      webchatBaseUrl: "https://webchat-dev.cognigy.ai",
      staticFilesBaseUrl: "https://static-dev.cognigy.ai",
      source: "env-profile",
    });
    eq(
      JSON.parse(JSON.stringify(described)),
      {
        name: "dev",
        apiHost: "api-dev.cognigy.ai",
        endpointHost: "endpoint-dev.cognigy.ai",
        source: "env-profile",
      },
      "describeProfile(profile without versionHint)",
      "R8: optional versionHint only when present",
      "Leave versionHint out when the profile has none.",
    );
  });

  it("the failure-message formatter redacts apiKey/key/token/secret at any depth", () => {
    const text = show({
      apiKey: "K-1",
      nested: {
        token: "T-2",
        list: [{ secret: "S-3" }, { Key: "K-4" }],
        keep: "visible",
      },
    });
    ok(
      !/K-1|T-2|S-3|K-4/.test(text) && text.includes("visible"),
      "show(object with credentials)",
      "A: failing assertions must never echo credentials",
      "sensitive properties redacted, others preserved",
      text,
      "Redact credential-like property names recursively.",
    );
  });
});

describe("Rule B: pure loader and explicit system loader", () => {
  it("loadProfiles() with no arguments returns the empty set", () => {
    eq(
      snapSet(loadProfiles()),
      EMPTY,
      "loadProfiles()",
      "B: defaults are empty, nothing is read implicitly",
      "Return an empty ProfileSet.",
    );
  });

  it("loadProfiles({ legacyFile }) ignores process.env", () => {
    const saved = { ...process.env };
    try {
      process.env.COGNIGY_API_BASE_URL = "https://api-from-process-env.test";
      process.env.COGNIGY_API_KEY = "process-env-key";
      process.env[`${P}ZZPURE_API_BASE_URL`] = "https://api-zzpure.test";
      process.env[`${P}ZZPURE_API_KEY`] = "process-env-key-2";
      process.env.COGNIGY_PROFILE = "zzpure";
      const set = loadProfiles({
        legacyFile: {
          COGNIGY_API_BASE_URL: URL_DEV,
          COGNIGY_API_KEY: "test-key-file",
        },
      });
      const p = only(set, "default");
      eq(
        [names(set), p.apiBaseUrl, p.apiKey, p.source, set.defaultName],
        [["default"], URL_DEV, "test-key-file", "legacy-file", "default"],
        "loadProfiles({legacyFile}) with distinctive process.env values",
        "B: loadProfiles is pure and never reads process.env",
        "Read configuration only from the options passed in.",
      );
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    }
  });

  it("loadProfilesFromSystem combines injected env, legacy-file reader and profiles-file reader", () => {
    let legacyCalls = 0;
    let profilesCalls = 0;
    const deps = {
      env: {
        COGNIGY_API_KEY: "test-key-env",
        ...envProfile("ENVP", "https://api-envp.cognigy.ai", "test-key-envp"),
      },
      readLegacyFile: () => {
        legacyCalls += 1;
        return { COGNIGY_API_BASE_URL: URL_DEV };
      },
      readProfilesFile: () => {
        profilesCalls += 1;
        return fileOf({
          filep: {
            apiBaseUrl: "https://api-filep.cognigy.ai",
            apiKey: "test-key-filep",
          },
        });
      },
    };
    const set = loadProfilesFromSystem(deps);
    const expected = loadProfiles({
      env: deps.env,
      legacyFile: { COGNIGY_API_BASE_URL: URL_DEV },
      fileProfiles: fileOf({
        filep: {
          apiBaseUrl: "https://api-filep.cognigy.ai",
          apiKey: "test-key-filep",
        },
      }),
    });
    eq(
      snapSet(set),
      snapSet(expected),
      "loadProfilesFromSystem(fakes)",
      "B: system loader = loadProfiles over the injected sources",
      "Feed the injected env and readers into loadProfiles.",
    );
    ok(
      legacyCalls >= 1 && profilesCalls >= 1,
      "loadProfilesFromSystem reader usage",
      "B: both readers are consulted",
      "each reader called at least once",
      `legacy=${legacyCalls} profiles=${profilesCalls}`,
      "Use the injected readers instead of real files.",
    );
    eq(
      names(set),
      ["default", "envp", "filep"],
      "loadProfilesFromSystem profile names",
      "B: all three sources contribute",
      "Merge legacy, env and file profiles.",
    );
  });

  it("loadProfilesFromSystem defaults env to process.env (with injected readers only)", () => {
    const key = `${P}ZZSYS_API_KEY`;
    const url = `${P}ZZSYS_API_BASE_URL`;
    const savedKey = process.env[key];
    const savedUrl = process.env[url];
    try {
      process.env[key] = "test-key-zzsys";
      process.env[url] = "https://api-zzsys.test";
      const set = loadProfilesFromSystem({
        readLegacyFile: () => ({}),
        readProfilesFile: () => ({ profiles: {}, problems: [] }),
      });
      ok(
        names(set).includes("zzsys"),
        "loadProfilesFromSystem() default env",
        "B: the system loader reads process.env",
        'profile "zzsys" present',
        `profiles: ${names(set).join(",")}`,
        "Default the env source to process.env.",
      );
    } finally {
      if (savedKey === undefined) delete process.env[key];
      else process.env[key] = savedKey;
      if (savedUrl === undefined) delete process.env[url];
      else process.env[url] = savedUrl;
    }
  });

  it("loadProfilesFromSystem ignores process.env when env is injected", () => {
    const key = `${P}ZZSYS2_API_KEY`;
    const url = `${P}ZZSYS2_API_BASE_URL`;
    try {
      process.env[key] = "test-key-zzsys2";
      process.env[url] = "https://api-zzsys2.test";
      const set = loadProfilesFromSystem({
        env: {},
        readLegacyFile: () => ({}),
        readProfilesFile: () => ({ profiles: {}, problems: [] }),
      });
      eq(
        snapSet(set),
        EMPTY,
        "loadProfilesFromSystem({env:{}})",
        "B: injected env replaces process.env",
        "Never mix process.env into an injected environment.",
      );
    } finally {
      delete process.env[key];
      delete process.env[url];
    }
  });
});

describe("Rule 9: edge cases", () => {
  it.each([
    [
      "env profile, invalid URL",
      () =>
        loadProfiles({
          env: {
            ...envProfile("V4", "not a url", "test-key-aaaa"),
            ...GOOD_ENV,
          },
        }),
      "v4",
    ],
    [
      "file profile, invalid URL",
      () =>
        loadProfiles({
          env: GOOD_ENV,
          fileProfiles: fileOf({
            staging: { apiBaseUrl: "not a url", apiKey: "test-key-aaaa" },
          }),
        }),
      "staging",
    ],
    [
      "invalid explicit endpoint URL",
      () =>
        loadProfiles({
          env: {
            ...envProfile("V4", URL_DEV, "test-key-aaaa", {
              ENDPOINT_BASE_URL: "not a url",
            }),
            ...GOOD_ENV,
          },
        }),
      "v4",
    ],
  ])(
    "%s => per-profile problem naming the profile, valid siblings survive",
    (label, fn, name) => {
      const set = fn();
      eq(
        names(set),
        ["ok"],
        `loadProfiles(${label})`,
        "C/R9: invalid URL breaks only its profile",
        "Keep valid siblings.",
      );
      expectProblem(
        set,
        name,
        `loadProfiles(${label})`,
        "R9: invalid URL strings are configuration problems",
      );
    },
  );

  it("trims whitespace on URL, key and optional settings", () => {
    const p = only(
      loadProfiles({
        env: envProfile("X", "  https://api.test  ", "  test-key-aaaa\t", {
          PLATFORM_VERSION: " v4 ",
        }),
      }),
      "x",
    );
    eq(
      [p.apiBaseUrl, p.apiKey, p.versionHint],
      ["https://api.test", "test-key-aaaa", "v4"],
      "whitespace-padded values",
      "R9: whitespace is trimmed",
      "Trim every setting value.",
    );
  });

  it("treats undefined env values and empty optional settings as unset", () => {
    const p = only(
      loadProfiles({
        env: envProfile("X", URL_DEV, "test-key-aaaa", {
          ENDPOINT_BASE_URL: "",
          WEBCHAT_BASE_URL: undefined,
        }),
      }),
      "x",
    );
    eq(
      [p.endpointBaseUrl, p.webchatBaseUrl],
      ["https://endpoint-dev.cognigy.ai", "https://webchat-dev.cognigy.ai"],
      "empty/undefined optional settings",
      "R9: empty counts as unset",
      "Derive the hosts when optional settings are empty.",
    );
  });

  it("sorts profiles by name ascending across env, file and legacy sources", () => {
    const set = loadProfiles({
      env: {
        COGNIGY_API_BASE_URL: URL_DEV,
        COGNIGY_API_KEY: "test-key-legacy",
        ...envProfile("ZETA", URL_DEV, "test-key-z"),
        ...envProfile("ALPHA", URL_DEV, "test-key-a"),
      },
      fileProfiles: fileOf({
        mid: { apiBaseUrl: URL_DEV, apiKey: "test-key-m" },
      }),
    });
    eq(
      names(set),
      ["alpha", "default", "mid", "zeta"],
      "profile order",
      "R9/ProfileSet: profiles sorted by name ascending",
      "Return profiles alphabetically by name.",
    );
  });

  it("never mutates its inputs", () => {
    const env = deepFreeze({
      COGNIGY_API_BASE_URL: URL_DEV,
      COGNIGY_API_KEY: "test-key-legacy",
      COGNIGY_PROFILE: "dev",
      ...envProfile("DEV", URL_DEV, "test-key-aaaa"),
    }) as NodeJS.ProcessEnv;
    const legacyFile = deepFreeze({ COGNIGY_API_KEY: "test-key-file" });
    const fileProfiles = deepFreeze(
      fileOf(
        {
          other: { apiBaseUrl: URL_DEV, apiKey: "test-key-o" },
          bad: { apiBaseUrl: "nope", apiKey: "k" },
        },
        "other",
      ),
    );
    const snapshot = JSON.stringify({ env, legacyFile, fileProfiles });
    const set = loadProfiles({ env, legacyFile, fileProfiles });
    eq(
      JSON.stringify({ env, legacyFile, fileProfiles }),
      snapshot,
      "inputs after loadProfiles",
      "R9: loadProfiles never mutates its inputs (frozen inputs would throw)",
      "Build new objects instead of editing the inputs.",
    );
    eq(
      [names(set), problemNames(set)],
      [["default", "dev", "other"], ["bad"]],
      "profiles from frozen inputs",
      "R9",
      "Still load correctly from read-only inputs.",
    );
  });

  it("empty env => empty ProfileSet without throwing", () => {
    eq(
      snapSet(loadProfiles({ env: {} })),
      EMPTY,
      "loadProfiles({env: {}})",
      "R9: no configuration is not an error",
      "Return an empty ProfileSet.",
    );
  });
});
