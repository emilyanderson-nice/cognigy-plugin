import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { eq, ok, raises } from "./helpers/specAssert.js";

// Serve the credential file from memory so the test never touches the real
// ~/.cognigy-plugin. Every other path is delegated to the real fs.
const actualFs = await import("fs");
type Step = string | Error;
let script: Step[] = [];
let credentialReads = 0;
const CRED_PATH = /[\\/]\.cognigy-plugin[\\/]config\.json$/;

const readFileSync = jest.fn((path: unknown, ...rest: unknown[]) => {
  if (typeof path === "string" && CRED_PATH.test(path)) {
    const step = script[Math.min(credentialReads, script.length - 1)];
    credentialReads += 1;
    if (step instanceof Error) throw step;
    return step;
  }
  return (actualFs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
});
jest.unstable_mockModule("fs", () => ({
  ...actualFs,
  default: { ...actualFs, readFileSync },
  readFileSync,
}));

const { loadProfilesFromSystem, ProfileConfigError } = await import(
  "../profiles/profiles.js"
);
const { createEnvironmentRegistry, EnvironmentError } = await import(
  "../environments/registry.js"
);

const URL_A = "https://api-a.cognigy.ai";
const URL_B = "https://api-b.cognigy.ai";
const URL_C = "https://api-c.cognigy.ai";
const KEY_A = "key-A-0123456789";
const KEY_B = "key-B-0123456789";
const KEY_C = "key-C-0123456789";

const OLD_DOC = JSON.stringify({
  COGNIGY_API_BASE_URL: URL_A,
  COGNIGY_API_KEY: KEY_A,
  profiles: { b: { apiBaseUrl: URL_B, apiKey: KEY_B } },
});
const NEW_DOC = JSON.stringify({
  COGNIGY_API_BASE_URL: URL_C,
  COGNIGY_API_KEY: KEY_C,
});
const enoent = (): Error =>
  Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const MODES: Array<[string, boolean | undefined]> = [
  ["strict", true],
  ["lenient", undefined],
];

function load(strict: boolean | undefined) {
  return loadProfilesFromSystem({
    env: {},
    ...(strict === undefined ? {} : { strict }),
  });
}
const snapshot = (set: ReturnType<typeof load>) => ({
  names: set.profiles.map((p) => p.name),
  keys: Object.fromEntries(set.profiles.map((p) => [p.name, p.apiKey])),
  defaultName: set.defaultName,
});

beforeEach(() => {
  script = [];
  credentialReads = 0;
});
afterEach(() => {
  script = [];
});

describe.each(MODES)(
  "loadProfilesFromSystem single read (%s)",
  (_m, strict) => {
    it("reads the credential file exactly once per call", () => {
      script = [OLD_DOC];
      load(strict);
      eq(
        credentialReads,
        1,
        `${_m} read count`,
        "S1: one load builds its snapshot from one read of the credential file",
        "Read and parse the file once per load and derive every section from that single document.",
      );
    });

    it("a file replaced during the load yields the OLD snapshot, never a mix", () => {
      script = [OLD_DOC, NEW_DOC];
      const snap = snapshot(load(strict));
      const consistent = [
        {
          names: ["b", "default"],
          keys: { b: KEY_B, default: KEY_A },
          defaultName: "default",
        },
        {
          names: ["default"],
          keys: { default: KEY_C },
          defaultName: "default",
        },
      ];
      ok(
        consistent.some((c) => JSON.stringify(c) === JSON.stringify(snap)),
        `${_m} snapshot consistency`,
        "S2: a snapshot must be one that existed on disk (old or new), not a combination",
        "names [b,default] with default=A, or names [default] with default=C",
        JSON.stringify({ ...snap, keys: Object.keys(snap.keys) }),
        "Never combine legacy fields from one file version with the profiles section of another.",
      );
      eq(
        snap,
        {
          names: ["b", "default"],
          keys: { b: KEY_B, default: KEY_A },
          defaultName: "default",
        },
        `${_m} old snapshot`,
        "S2: with one read the first-read document is used for the whole snapshot",
        "Use the document that was read once; later replacements apply to the next load.",
      );
    });

    it("a second load after the replacement sees the NEW document", () => {
      script = [OLD_DOC, NEW_DOC];
      load(strict);
      const second = snapshot(load(strict));
      eq(
        second,
        {
          names: ["default"],
          keys: { default: KEY_C },
          defaultName: "default",
        },
        `${_m} next load`,
        "S2: each load takes a fresh read, so the replacement is visible next time",
        "Do not cache the document across load calls.",
      );
    });
  },
);

describe.each(MODES)(
  "environment registry over a replaced file (%s)",
  (_m, strict) => {
    const makeRegistry = () =>
      createEnvironmentRegistry({
        loadProfiles: () =>
          loadProfilesFromSystem({
            env: {},
            ...(strict === undefined ? {} : { strict }),
          }),
        createRuntime: (profile) => ({
          profile,
          client: {},
          handlers: { handleToolCall: async () => ({}) },
        }),
      });

    it("an unnamed resolve on a file replaced mid-load is ambiguous, never environment A", () => {
      script = [OLD_DOC, NEW_DOC];
      const err = raises(
        () => makeRegistry().resolve(),
        EnvironmentError,
        `${_m} unnamed resolve`,
        "S4: the old document has two environments (default and b), so an unnamed call must not pick one",
        "Resolve from one snapshot; with two configured environments throw ambiguous instead of returning key A's runtime.",
      );
      eq(
        err.code,
        "ambiguous",
        `${_m} unnamed resolve code`,
        "S4: the error must tell the caller to name an environment",
        "Throw EnvironmentError with code ambiguous when more than one environment is configured.",
      );
    });

    it("a named resolve on a file replaced mid-load returns that environment", () => {
      script = [OLD_DOC, NEW_DOC];
      const runtime = makeRegistry().resolve("b");
      eq(
        runtime.profile.name,
        "b",
        `${_m} named resolve`,
        "S4: profile b exists in the document that was read, so it must resolve",
        "Resolve against the single snapshot; do not look b up in a later read of the file.",
      );
    });
  },
);

describe.each(MODES)("loadProfilesFromSystem behaviour (%s)", (_m, strict) => {
  it("legacy-only file yields profile default", () => {
    script = [
      JSON.stringify({
        COGNIGY_API_BASE_URL: URL_A,
        COGNIGY_API_KEY: KEY_A,
      }),
    ];
    eq(
      snapshot(load(strict)),
      { names: ["default"], keys: { default: KEY_A }, defaultName: "default" },
      `${_m} legacy only`,
      "S3: flat legacy fields still form the default profile",
      "Keep mapping legacy fields to a profile named default.",
    );
  });

  it("named-only file yields those profiles and no default", () => {
    script = [
      JSON.stringify({
        profiles: {
          b: { apiBaseUrl: URL_B, apiKey: KEY_B },
          c: { apiBaseUrl: URL_C, apiKey: KEY_C },
        },
      }),
    ];
    eq(
      snapshot(load(strict)),
      {
        names: ["b", "c"],
        keys: { b: KEY_B, c: KEY_C },
        defaultName: undefined,
      },
      `${_m} named only`,
      "S3: named profiles load without inventing a default",
      "Return the named profiles only; no default when several exist.",
    );
  });

  it("a missing file yields no profiles", () => {
    script = [enoent()];
    eq(
      snapshot(load(strict)),
      { names: [], keys: {}, defaultName: undefined },
      `${_m} missing file`,
      "S3: an absent file means nothing is configured",
      "Treat ENOENT as an empty configuration.",
    );
  });
});

describe("loadProfilesFromSystem corrupt file", () => {
  it("strict mode throws ProfileConfigError", () => {
    script = ["{ nope"];
    raises(
      () => load(true),
      ProfileConfigError,
      "strict corrupt file",
      "S3: strict loading fails closed on malformed JSON",
      "Throw ProfileConfigError instead of reading as empty.",
    );
  });

  it("lenient mode yields no profiles", () => {
    script = ["{ nope"];
    eq(
      snapshot(load(undefined)),
      { names: [], keys: {}, defaultName: undefined },
      "lenient corrupt file",
      "S3: lenient loading reads a malformed file as empty",
      "Swallow malformed content when strict is not requested.",
    );
  });
});
