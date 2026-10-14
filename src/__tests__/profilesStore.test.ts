import { describe, it, afterEach, jest } from "@jest/globals";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { ProfileConfigError, loadProfiles } from "../profiles/profiles.js";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import type { RawFileProfile } from "../profiles/profilesFile.js";
import {
  removeProfile,
  setDefaultProfile,
  upsertProfile,
} from "../profiles/profilesStore.js";
import { writeUserConfigFile } from "../userConfigFile.js";
import { eq, ok, raises, show } from "./helpers/specAssert.js";

type Runner = (
  command: string,
  args: string[],
) => { status: number | null; stdout?: string; stderr?: string };
type Call = { command: string; args: string[] };

const KEY = "fake-key-SECRET-7f3a9c";
const DEV: RawFileProfile = {
  apiBaseUrl: "https://api-dev.test",
  apiKey: "fake-key-dev",
};
const PROD: RawFileProfile = {
  apiBaseUrl: "https://api.prod.test",
  apiKey: "fake-key-prod",
  endpointBaseUrl: "https://ep.prod.test",
  versionHint: "v4",
};

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-pstore-"));
  tmpDirs.push(dir);
  return dir;
}
let stderrSpy: { mockRestore: () => void } | undefined;
afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});
function captureStderr(): () => string[] {
  const spy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as never);
  stderrSpy = spy;
  return () => spy.mock.calls.map((c) => String(c[0]));
}

/** Fresh temp config path + injected fake icacls runner (never touches real ACLs). */
function setup(initial?: string | Buffer | object): {
  dir: string;
  path: string;
  calls: Call[];
  opts: { path: string; platform: NodeJS.Platform; run: Runner };
} {
  const dir = freshDir();
  const path = join(dir, "config.json");
  if (initial !== undefined) {
    writeFileSync(
      path,
      typeof initial === "string" || Buffer.isBuffer(initial)
        ? initial
        : JSON.stringify(initial),
    );
  }
  const calls: Call[] = [];
  const run: Runner = (command, args) => {
    if (command === "whoami") return { status: 1 }; // forces env-name fallback (H7)
    calls.push({ command, args: [...args] });
    return { status: 0 };
  };
  return { dir, path, calls, opts: { path, platform: "win32", run } };
}
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
function bad(
  p: Partial<Record<keyof RawFileProfile, unknown>>,
): RawFileProfile {
  return { ...DEV, ...p } as unknown as RawFileProfile;
}

const RICH = {
  COGNIGY_API_BASE_URL: "https://api-trial.test",
  COGNIGY_API_KEY: "fake-key-legacy",
  defaultProfile: "dev",
  profiles: { dev: DEV, prod: PROD },
  unknownObj: { a: [1, { b: 2 }] },
  unknownNum: 7,
  unknownArr: ["x"],
};

// ------------------------------------------------------------ rule 1
describe("upsertProfile: writes with restriction applied (rule 1)", () => {
  it("creates the file with only the new profile, trimmed, and restricts dir then file", () => {
    const s = setup();
    const result = upsertProfile(
      "v4-staging",
      {
        apiBaseUrl: "  https://api-stg.test/  ",
        apiKey: "  fake-key-aaaa  ",
        endpointBaseUrl: " https://ep.test ",
        webchatBaseUrl: "https://wc.test",
        staticFilesBaseUrl: "https://st.test",
        versionHint: "v4",
      },
      s.opts,
    );
    eq(
      result,
      { created: true },
      "upsertProfile(new)",
      "1/2: created is true for a new name",
      "Return created:true when the name did not exist.",
    );
    eq(
      readJson(s.path),
      {
        profiles: {
          "v4-staging": {
            apiBaseUrl: "https://api-stg.test",
            apiKey: "fake-key-aaaa",
            endpointBaseUrl: "https://ep.test",
            webchatBaseUrl: "https://wc.test",
            staticFilesBaseUrl: "https://st.test",
            versionHint: "v4",
          },
        },
      },
      "upsertProfile(new, stored JSON)",
      "1/3: values trimmed, trailing slash dropped from apiBaseUrl, file holds only the profile",
      "Store trimmed values; strip one trailing slash from apiBaseUrl; add nothing else.",
    );
    eq(
      s.calls.map((c) => [c.command, c.args[0]]),
      [
        ["icacls", s.dir],
        ["icacls", s.path],
      ],
      "upsertProfile(restrict calls)",
      "1: owner-only restriction on dir then file",
      "Apply restrictToOwner to the directory and then the file using the injected platform/runner.",
    );
  });

  it("creates missing nested directories", () => {
    const base = freshDir();
    const path = join(base, "x", "y", "config.json");
    const s = setup();
    upsertProfile("dev", DEV, { ...s.opts, path });
    eq(
      readJson(path),
      { profiles: { dev: DEV } },
      "upsertProfile(missing dir)",
      "3: a missing dir/file is created",
      "Create the directory tree and the file.",
    );
  });

  it.each([["a"], ["0x"], ["v4-staging"], ["a1-b2-c3"]])(
    "accepts valid name %j",
    (name) => {
      const s = setup();
      upsertProfile(name, DEV, s.opts);
      eq(
        Object.keys((readJson(s.path) as { profiles: object }).profiles),
        [name],
        `upsertProfile(${name})`,
        "1: names matching /^[a-z0-9][a-z0-9-]*$/ are accepted",
        "Accept names that start with a lowercase letter or digit and use lowercase, digits, hyphens.",
      );
    },
  );
});

describe("upsertProfile: validation (rule 1)", () => {
  const cases: [string, string, RawFileProfile][] = [
    ["empty name", "", { ...DEV, apiKey: KEY }],
    ["uppercase name", "Dev", { ...DEV, apiKey: KEY }],
    ["leading hyphen", "-dev", { ...DEV, apiKey: KEY }],
    ["space in name", "my dev", { ...DEV, apiKey: KEY }],
    ["underscore in name", "my_dev", { ...DEV, apiKey: KEY }],
    ["dot in name", "a.b", { ...DEV, apiKey: KEY }],
    ["__proto__ name", "__proto__", { ...DEV, apiKey: KEY }],
    ["constructor name", "constructor", { ...DEV, apiKey: KEY }],
    ["prototype name", "prototype", { ...DEV, apiKey: KEY }],
    ["empty apiBaseUrl", "dev", bad({ apiKey: KEY, apiBaseUrl: "" })],
    ["whitespace apiBaseUrl", "dev", bad({ apiKey: KEY, apiBaseUrl: "   " })],
    [
      "unparseable apiBaseUrl",
      "dev",
      bad({ apiKey: KEY, apiBaseUrl: "not a url" }),
    ],
    ["ftp apiBaseUrl", "dev", bad({ apiKey: KEY, apiBaseUrl: "ftp://x.test" })],
    [
      "javascript apiBaseUrl",
      "dev",
      bad({ apiKey: KEY, apiBaseUrl: "javascript:alert(1)" }),
    ],
    ["non-string apiBaseUrl", "dev", bad({ apiKey: KEY, apiBaseUrl: 5 })],
    ["empty apiKey", "dev", bad({ apiKey: "" })],
    ["whitespace apiKey", "dev", bad({ apiKey: "   " })],
    ["non-string apiKey", "dev", bad({ apiKey: 12345 })],
    [
      "bad endpointBaseUrl",
      "dev",
      bad({ apiKey: KEY, endpointBaseUrl: "nope" }),
    ],
    [
      "ftp webchatBaseUrl",
      "dev",
      bad({ apiKey: KEY, webchatBaseUrl: "ftp://w.test" }),
    ],
    [
      "bad staticFilesBaseUrl",
      "dev",
      bad({ apiKey: KEY, staticFilesBaseUrl: "::" }),
    ],
    ["non-string versionHint", "dev", bad({ apiKey: KEY, versionHint: 4 })],
  ];

  it.each(cases)(
    "rejects %s with ProfileConfigError, no key in message, nothing written",
    (label, name, profile) => {
      const s = setup(RICH);
      const before = readFileSync(s.path, "utf8");
      const captured = captureStderr();
      const err = raises(
        () => upsertProfile(name, profile, s.opts),
        ProfileConfigError,
        `upsertProfile(${label})`,
        "1: invalid input raises ProfileConfigError",
        "Reject invalid names, URLs, keys and hints with a ProfileConfigError before touching the file.",
      );
      ok(
        !err.message.includes(KEY) && !captured().join("").includes(KEY),
        `upsertProfile(${label}) secrecy`,
        "1/7: message and stderr never contain the key",
        "no key material",
        "key present in message or stderr",
        "Never include the API key in errors or output.",
      );
      eq(
        [readFileSync(s.path, "utf8"), readdirSync(s.dir), s.calls.length],
        [before, ["config.json"], 0],
        `upsertProfile(${label}) side effects`,
        "1: validation failure leaves file, directory and ACLs untouched",
        "Validate first; write, back up and restrict nothing on failure.",
      );
    },
  );
});

// ------------------------------------------------------------ rule 2
describe("upsertProfile: preservation (rule 2)", () => {
  it("adds a profile and preserves everything else", () => {
    const s = setup(RICH);
    const newP = { apiBaseUrl: "https://api-new.test", apiKey: "fake-key-new" };
    eq(
      upsertProfile("new", newP, s.opts),
      { created: true },
      "upsertProfile(add)",
      "2: created true for a new name",
      "Return created:true.",
    );
    eq(
      readJson(s.path),
      { ...RICH, profiles: { dev: DEV, prod: PROD, new: newP } },
      "upsertProfile(add, preservation)",
      "2: legacy keys, defaultProfile, unknown keys and other profiles survive",
      "Change only the added profile; keep every other key and profile as it was.",
    );
  });

  it("replaces a whole profile: fields not given are removed, created false", () => {
    const s = setup(RICH);
    const replacement = {
      apiBaseUrl: "https://api-prod2.test",
      apiKey: "fake-key-p2",
    };
    eq(
      upsertProfile("prod", replacement, s.opts),
      { created: false },
      "upsertProfile(replace)",
      "2: created false when replacing",
      "Return created:false when the name existed.",
    );
    eq(
      readJson(s.path),
      { ...RICH, profiles: { dev: DEV, prod: replacement } },
      "upsertProfile(replace, whole-profile)",
      "2: endpointBaseUrl/versionHint of the old profile are gone",
      "Replace the profile wholesale; do not merge old optional fields into it.",
    );
  });

  it("does not create a backup for a valid file", () => {
    const s = setup(RICH);
    upsertProfile("new", DEV, s.opts);
    eq(
      readdirSync(s.dir),
      ["config.json"],
      "upsertProfile(valid file listing)",
      "3/C: no .bak and no temp file for a valid file",
      "Back up only corrupt files and leave no temporary files.",
    );
  });
});

// ------------------------------------------------------------ rule 3
describe("upsertProfile: corrupt files (rule 3)", () => {
  it.each([
    ["invalid JSON", "{ not json"],
    ["top-level array", '["a"]'],
    ["top-level number", "42"],
  ])("backs up %s and writes only the new profile", (label, text) => {
    const s = setup(text);
    upsertProfile("dev", DEV, s.opts);
    eq(
      readFileSync(join(s.dir, "config.json.bak"), "utf8"),
      text,
      `upsertProfile(${label}) backup`,
      "3: corrupt original saved verbatim to config.json.bak",
      "Keep the unreadable original in config.json.bak.",
    );
    eq(
      readJson(s.path),
      { profiles: { dev: DEV } },
      `upsertProfile(${label}) new file`,
      "3: replaced by a file containing only the new profile",
      "Write just the new profile.",
    );
  });

  it.each([
    ["string", "oops"],
    ["number", 5],
    ["array", []],
    ["null", null],
  ])("drops a non-object profiles value (%s) and backs up", (label, value) => {
    const original = {
      COGNIGY_API_KEY: "fake-key-legacy",
      defaultProfile: "dev",
      profiles: value,
    };
    const text = JSON.stringify(original);
    const s = setup(text);
    eq(
      upsertProfile("dev", DEV, s.opts),
      { created: true },
      `upsertProfile(profiles=${label})`,
      "3: bad profiles treated as empty, so the name is new",
      "Treat a non-object profiles value as having no profiles.",
    );
    eq(
      readJson(s.path),
      {
        COGNIGY_API_KEY: "fake-key-legacy",
        defaultProfile: "dev",
        profiles: { dev: DEV },
      },
      `upsertProfile(profiles=${label}) content`,
      "3: bad value dropped, other keys preserved",
      "Replace the bad profiles value by an object holding the new profile; keep other keys.",
    );
    eq(
      readFileSync(join(s.dir, "config.json.bak"), "utf8"),
      text,
      `upsertProfile(profiles=${label}) backup`,
      "3: a backup is taken when profiles is dropped",
      "Back up the original before dropping the bad value.",
    );
  });
});

// ------------------------------------------------------------ rule 4
describe("removeProfile (rule 4)", () => {
  it("removes only that profile, returns true, preserves the rest", () => {
    const s = setup(RICH);
    eq(
      removeProfile("prod", s.opts),
      true,
      "removeProfile(existing)",
      "4: true when it existed",
      "Return true when a profile was removed.",
    );
    eq(
      readJson(s.path),
      { ...RICH, profiles: { dev: DEV } },
      "removeProfile(existing, content)",
      "4: everything else preserved including defaultProfile",
      "Delete only the named profile.",
    );
  });

  it("deletes defaultProfile when the removed profile was the default", () => {
    const s = setup(RICH);
    removeProfile("dev", s.opts);
    const { defaultProfile: _d, ...rest } = RICH;
    void _d;
    eq(
      readJson(s.path),
      { ...rest, profiles: { prod: PROD } },
      "removeProfile(default)",
      "4: defaultProfile removed with its profile",
      "Do not leave defaultProfile pointing at a removed profile.",
    );
  });

  it("leaves profiles as {} when the last profile is removed", () => {
    const s = setup({ profiles: { dev: DEV }, KEEP: "1" });
    removeProfile("dev", s.opts);
    eq(
      readJson(s.path),
      { profiles: {}, KEEP: "1" },
      "removeProfile(last)",
      '4: "profiles": {} is kept, not deleted',
      "Keep an empty profiles object.",
    );
  });

  it.each([["missing"], ["constructor"], ["__proto__"], ["toString"]])(
    "returns false and leaves the file byte-identical for absent name %j",
    (name) => {
      const s = setup(RICH);
      const before = readFileSync(s.path);
      eq(
        removeProfile(name, s.opts),
        false,
        `removeProfile(${name})`,
        "4: false when absent (own properties only)",
        "Return false for names that are not own profiles, including inherited property names.",
      );
      ok(
        readFileSync(s.path).equals(before) && s.calls.length === 0,
        `removeProfile(${name}) file`,
        "4: file not touched when nothing is removed",
        "identical bytes, no restriction calls",
        "file or ACLs changed",
        "Do not rewrite the file when there is nothing to remove.",
      );
    },
  );

  it("returns false and creates no file when the file does not exist", () => {
    const s = setup();
    eq(
      [removeProfile("dev", s.opts), readdirSync(s.dir), s.calls.length],
      [false, [], 0],
      "removeProfile(no file)",
      "4: no file is created",
      "Return false without creating anything.",
    );
  });
});

// ------------------------------------------------------------ rule 5
describe("setDefaultProfile (rule 5)", () => {
  it("sets defaultProfile and preserves everything else", () => {
    const s = setup({ ...RICH, defaultProfile: "dev" });
    setDefaultProfile("prod", s.opts);
    eq(
      readJson(s.path),
      { ...RICH, defaultProfile: "prod" },
      "setDefaultProfile(prod)",
      "5: defaultProfile set, nothing else changed",
      "Set only defaultProfile.",
    );
  });

  it.each([["V4_STAGING"], ["v4-staging"], ["V4-Staging"], ["v4_staging"]])(
    "normalises %j to the stored name v4-staging",
    (input) => {
      const s = setup({ profiles: { "v4-staging": DEV } });
      setDefaultProfile(input, s.opts);
      eq(
        readJson(s.path),
        { profiles: { "v4-staging": DEV }, defaultProfile: "v4-staging" },
        `setDefaultProfile(${input})`,
        "5: lowercase and underscores to hyphens before matching",
        "Match names case-insensitively with underscores treated as hyphens and store the profile's name.",
      );
    },
  );

  it.each([["ghost"], ["constructor"]])(
    "throws ProfileConfigError listing existing names for unknown %j",
    (name) => {
      const s = setup(RICH);
      const before = readFileSync(s.path);
      const captured = captureStderr();
      const err = raises(
        () => setDefaultProfile(name, s.opts),
        ProfileConfigError,
        `setDefaultProfile(${name})`,
        "5: unknown profile raises ProfileConfigError",
        "Reject names that are not file profiles.",
      );
      ok(
        err.message.includes("dev") &&
          err.message.includes("prod") &&
          !err.message.includes("fake-key") &&
          !captured().join("").includes("fake-key"),
        `setDefaultProfile(${name}) message`,
        "5/7: lists existing names, no keys",
        "message names dev and prod, no key material",
        show(err.message),
        "List existing profile names only.",
      );
      ok(
        readFileSync(s.path).equals(before),
        `setDefaultProfile(${name}) file`,
        "5: file untouched on error",
        "identical bytes",
        "file changed",
        "Do not write when the name is unknown.",
      );
    },
  );

  it("throws ProfileConfigError for a name when the file does not exist and creates nothing", () => {
    const s = setup();
    raises(
      () => setDefaultProfile("dev", s.opts),
      ProfileConfigError,
      "setDefaultProfile(no file)",
      "5: requires an existing file profile",
      "Reject when no file profile of that name exists.",
    );
    eq(
      readdirSync(s.dir),
      [],
      "setDefaultProfile(no file) side effects",
      "5: no file created",
      "Create nothing when failing.",
    );
  });

  it("undefined removes defaultProfile and keeps the rest", () => {
    const s = setup(RICH);
    setDefaultProfile(undefined, s.opts);
    const { defaultProfile: _d, ...rest } = RICH;
    void _d;
    eq(
      readJson(s.path),
      rest,
      "setDefaultProfile(undefined)",
      "5: the key is removed, nothing else changes",
      "Delete defaultProfile only.",
    );
  });

  it("undefined with no file neither throws nor creates a file", () => {
    const s = setup();
    setDefaultProfile(undefined, s.opts);
    eq(
      [readdirSync(s.dir), s.calls.length],
      [[], 0],
      "setDefaultProfile(undefined, no file)",
      "5: no error, no file",
      "Do nothing when there is no file.",
    );
  });
});

// ------------------------------------------------------------ rule 6
describe("round trip and installer regression (rule 6)", () => {
  it("readUserProfilesFile and loadProfiles see the stored profile", () => {
    const s = setup();
    upsertProfile(
      "v4-staging",
      { apiBaseUrl: "https://api-stg.test", apiKey: "fake-key-rt" },
      s.opts,
    );
    const file = readUserProfilesFile(s.path);
    eq(
      file,
      {
        profiles: {
          "v4-staging": {
            apiBaseUrl: "https://api-stg.test",
            apiKey: "fake-key-rt",
          },
        },
        problems: [],
      },
      "readUserProfilesFile(after upsert)",
      "6: the stored profile reads back with no problems",
      "Write a profile the reader accepts without problems.",
    );
    const set = loadProfiles({ env: {}, fileProfiles: file });
    const p = set.profiles.find((x) => x.name === "v4-staging");
    ok(
      p?.apiKey === "fake-key-rt" && p.source === "file-profile",
      "loadProfiles(after upsert)",
      "6: Profile has the stored key and source file-profile",
      'apiKey "fake-key-rt", source "file-profile"',
      show({ source: p?.source, found: p !== undefined }),
      "Loading the written file yields the profile as a file-profile.",
    );
  });

  it("writeUserConfigFile after a profile write keeps profiles and defaultProfile", () => {
    const s = setup({
      COGNIGY_API_BASE_URL: "https://api-old.test",
      COGNIGY_API_KEY: "fake-key-old",
      OLD_ONLY: "gone",
    });
    upsertProfile("dev", DEV, s.opts);
    setDefaultProfile("dev", s.opts);
    writeUserConfigFile(
      {
        COGNIGY_API_BASE_URL: "https://api-new.test",
        COGNIGY_API_KEY: "fake-key-new",
      },
      s.dir,
      { platform: "win32", run: s.opts.run },
    );
    eq(
      readJson(s.path),
      {
        COGNIGY_API_BASE_URL: "https://api-new.test",
        COGNIGY_API_KEY: "fake-key-new",
        profiles: { dev: DEV },
        defaultProfile: "dev",
      },
      "writeUserConfigFile(after profile write)",
      "6/B: installer run updates flat keys but keeps profiles and defaultProfile",
      "Merge installer values into the file without deleting saved profiles.",
    );
  });
});

// ------------------------------------------------------------ rule 7
describe("secrecy across failure paths (rule 7)", () => {
  it("no error or stderr output contains the key on rename failure", () => {
    const s = setup();
    mkdirSync(s.path);
    const captured = captureStderr();
    const err = raises(
      () => upsertProfile("dev", { ...DEV, apiKey: KEY }, s.opts),
      Error,
      "upsertProfile(config.json is a directory)",
      "8: failure surfaces as an exception",
      "Throw when the file cannot be written.",
    );
    ok(
      !err.message.includes(KEY) && !captured().join("").includes(KEY),
      "upsertProfile(rename failure) secrecy",
      "7: no key in message or stderr",
      "no key material",
      "key present",
      "Keep credentials out of every error and log line.",
    );
  });

  it("a failing restriction does not throw and never leaks the key", () => {
    const s = setup();
    const captured = captureStderr();
    upsertProfile(
      "dev",
      { ...DEV, apiKey: KEY },
      {
        ...s.opts,
        run: () => ({ status: 1, stderr: "denied" }),
      },
    );
    eq(
      (readJson(s.path) as { profiles: { dev: RawFileProfile } }).profiles.dev
        .apiKey,
      KEY,
      "upsertProfile(restriction fails)",
      "1/E: a failed restriction is a warning, the write succeeds",
      "Write the profile even when permissions could not be tightened.",
    );
    ok(
      !captured().join("").includes(KEY),
      "upsertProfile(restriction fails) secrecy",
      "7: warning has no key",
      "no key on stderr",
      "key on stderr",
      "Keep credentials out of warnings.",
    );
  });
});

// ------------------------------------------------------------ rule 8
describe("atomicity (rule 8)", () => {
  it("throws, removes the temp file and leaves the original when rename fails", () => {
    const s = setup();
    mkdirSync(s.path);
    writeFileSync(join(s.path, "inner.txt"), "original");
    raises(
      () => upsertProfile("dev", DEV, s.opts),
      Error,
      "upsertProfile(rename fails)",
      "8: throws when the final rename fails",
      "Surface the failure to the caller.",
    );
    eq(
      readdirSync(s.dir).filter((n) => /\.tmp/.test(n)),
      [],
      "upsertProfile(rename fails) temp files",
      "8: temp file removed",
      "Clean up temporary files after a failed write.",
    );
    ok(
      statSync(s.path).isDirectory() &&
        readFileSync(join(s.path, "inner.txt"), "utf8") === "original",
      "upsertProfile(rename fails) original",
      "8: original untouched",
      "config.json still the original directory",
      "original altered",
      "Do not modify the target when the write fails.",
    );
  });

  it("leaves no temp file after a successful write", () => {
    const s = setup();
    upsertProfile("dev", DEV, s.opts);
    eq(
      readdirSync(s.dir),
      ["config.json"],
      "upsertProfile(success listing)",
      "8: only config.json remains",
      "Leave no temporary file behind.",
    );
  });
});

// ------------------------------------------------------------ rule 9
describe("never touches the real default location (rule 9)", () => {
  it("operations on a temp path leave the real ~/.cognigy-plugin untouched", () => {
    const realDir = join(homedir(), ".cognigy-plugin");
    const realCfg = join(realDir, "config.json");
    const snap = (p: string): [boolean, number | undefined] =>
      existsSync(p) ? [true, statSync(p).mtimeMs] : [false, undefined];
    const before = [snap(realCfg), snap(realDir)];

    const s = setup(RICH);
    upsertProfile("n1", DEV, s.opts);
    setDefaultProfile("n1", s.opts);
    removeProfile("n1", s.opts);
    setDefaultProfile(undefined, s.opts);

    eq(
      [snap(realCfg), snap(realDir)],
      before,
      "profilesStore(temp path) vs real config",
      "9: the real config file and directory are unchanged",
      "Use only the supplied path; never fall back to the default location.",
    );
    ok(
      s.calls.length > 0 &&
        s.calls.every((c) => !c.args[0].startsWith(dirname(realCfg))),
      "profilesStore(temp path) restriction targets",
      "9: restriction applied only to the supplied path",
      "icacls targets only temp paths",
      show(s.calls.map((c) => c.args[0])),
      "Restrict the directory and file of the supplied path, not the default.",
    );
  });
});
