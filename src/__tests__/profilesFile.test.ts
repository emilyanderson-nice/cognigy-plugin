import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import { readUserConfigFile } from "../userConfigFile.js";
import { eq, ok } from "./helpers/specAssert.js";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-profiles-file-"));
  tmpDirs.push(dir);
  return dir;
}
/** Writes raw text (so JSON such as an own "__proto__" key is preserved verbatim). */
function writeRaw(text: string): string {
  const file = join(freshDir(), "config.json");
  writeFileSync(file, text, "utf8");
  return file;
}
function writeJson(value: unknown): string {
  return writeRaw(JSON.stringify(value));
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

const GOOD = {
  apiBaseUrl: "https://api-dev.cognigy.ai",
  apiKey: "test-key-aaaa",
};

describe("readUserProfilesFile: unreadable input never throws (Module B, never-throws rule)", () => {
  it("returns an empty result for a missing file", () => {
    const missing = join(freshDir(), "does-not-exist.json");
    eq(
      readUserProfilesFile(missing),
      { profiles: {}, problems: [] },
      "readUserProfilesFile(missing path)",
      "B-never-throws: a missing file is not an error",
      "Return an empty profiles map for a path that does not exist, without throwing.",
    );
  });

  it("returns an empty result when the path is a directory (unreadable)", () => {
    const dir = freshDir();
    const sub = join(dir, "adir");
    mkdirSync(sub);
    eq(
      readUserProfilesFile(sub),
      { profiles: {}, problems: [] },
      "readUserProfilesFile(directory path)",
      "B-never-throws: an unreadable path is not an error",
      "Treat any read failure as an empty profiles map.",
    );
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["empty file", ""],
    ["array top level", "[]"],
    ["string top level", '"text"'],
    ["number top level", "42"],
    ["null top level", "null"],
  ])("returns an empty result for %s", (label, text) => {
    eq(
      readUserProfilesFile(writeRaw(text)),
      { profiles: {}, problems: [] },
      `readUserProfilesFile(${label})`,
      "B-never-throws: invalid or non-object JSON is tolerated",
      "Return an empty profiles map for any content that is not a JSON object.",
    );
  });
});

describe("readUserProfilesFile: valid files", () => {
  it("returns defaultProfile and every well-formed profile with all supported fields", () => {
    const file = writeJson({
      defaultProfile: "dev",
      profiles: {
        dev: {
          apiBaseUrl: "https://api-dev.cognigy.ai",
          apiKey: "test-key-aaaa",
          endpointBaseUrl: "https://endpoint-dev.cognigy.ai",
          webchatBaseUrl: "https://webchat-dev.cognigy.ai",
          staticFilesBaseUrl: "https://static-dev.cognigy.ai",
          versionHint: "v4",
        },
        prod: { apiBaseUrl: "https://api.prod.test", apiKey: "test-key-bbbb" },
      },
    });
    eq(
      readUserProfilesFile(file),
      {
        defaultProfile: "dev",
        profiles: {
          dev: {
            apiBaseUrl: "https://api-dev.cognigy.ai",
            apiKey: "test-key-aaaa",
            endpointBaseUrl: "https://endpoint-dev.cognigy.ai",
            webchatBaseUrl: "https://webchat-dev.cognigy.ai",
            staticFilesBaseUrl: "https://static-dev.cognigy.ai",
            versionHint: "v4",
          },
          prod: {
            apiBaseUrl: "https://api.prod.test",
            apiKey: "test-key-bbbb",
          },
        },
        problems: [],
      },
      "readUserProfilesFile(valid file)",
      "B-shape: file profiles are returned field-for-field",
      "Return defaultProfile and each profile exactly as written, without inventing or dropping fields.",
    );
  });

  it("tolerates a UTF-8 BOM at the start of the file", () => {
    const file = writeRaw("﻿" + JSON.stringify({ profiles: { dev: GOOD } }));
    eq(
      readUserProfilesFile(file),
      { profiles: { dev: GOOD }, problems: [] },
      "readUserProfilesFile(file with BOM)",
      "B-bom: Windows editors prepend a BOM",
      "Ignore a leading BOM so the JSON still parses.",
    );
  });

  it("reads profiles from the same file that holds flat legacy keys", () => {
    const file = writeJson({
      COGNIGY_API_BASE_URL: "https://api-trial.cognigy.ai",
      COGNIGY_API_KEY: "test-key-legacy",
      profiles: { dev: GOOD },
    });
    eq(
      readUserProfilesFile(file),
      { profiles: { dev: GOOD }, problems: [] },
      "readUserProfilesFile(mixed legacy + profiles file)",
      "B-shape: one config.json holds both formats",
      "Return only the profiles section; flat legacy keys must not leak into the result.",
    );
  });

  it("ignores unknown extra fields on a profile", () => {
    const file = writeJson({
      profiles: { dev: { ...GOOD, color: "red", nested: { a: 1 } } },
    });
    const result = readUserProfilesFile(file);
    eq(
      Object.keys(result.profiles.dev ?? {}).sort(),
      ["apiBaseUrl", "apiKey"],
      "readUserProfilesFile(profile with unknown fields)",
      "B-extra-fields: unknown fields are ignored",
      "Keep only the documented profile fields.",
    );
  });

  it("returns only profiles for a flat-legacy-only file (backward compatibility)", () => {
    const file = writeJson({
      COGNIGY_API_BASE_URL: "https://api-trial.cognigy.ai",
      COGNIGY_API_KEY: "test-key-legacy",
    });
    eq(
      readUserProfilesFile(file),
      { profiles: {}, problems: [] },
      "readUserProfilesFile(legacy-only file)",
      "B-backcompat: an old-format file has no profiles",
      "Return an empty profiles map and no defaultProfile when the file holds only flat legacy keys.",
    );
  });

  it.each([
    ["profiles is an array", { profiles: [GOOD] }],
    ["profiles is a string", { profiles: "dev" }],
    ["profiles is null", { profiles: null }],
  ])("returns an empty profiles map when %s", (label, content) => {
    // Whether a non-object profiles section is also reported as a problem is unspecified.
    eq(
      readUserProfilesFile(writeJson(content)).profiles,
      {},
      `readUserProfilesFile(${label})`,
      "B-shape: profiles must be an object map",
      "Treat a non-object profiles section as empty without throwing.",
    );
  });

  it("omits a non-string defaultProfile", () => {
    const result = readUserProfilesFile(
      writeJson({ defaultProfile: 5, profiles: { dev: GOOD } }),
    );
    eq(
      result,
      { profiles: { dev: GOOD }, problems: [] },
      "readUserProfilesFile(non-string defaultProfile)",
      "B-shape: defaultProfile is a string",
      "Only report defaultProfile when it is a string.",
    );
    ok(
      result.defaultProfile === undefined,
      "readUserProfilesFile(non-string defaultProfile).defaultProfile",
      "B-shape: defaultProfile is a string",
      "undefined",
      String(result.defaultProfile),
      "Drop a numeric defaultProfile.",
    );
  });
});

describe("readUserProfilesFile: malformed entries are dropped, valid siblings survive", () => {
  it.each([
    ["a string", "dev-only"],
    ["null", null],
    ["an array", [GOOD]],
    ["a number", 7],
    ["missing apiBaseUrl", { apiKey: "test-key-aaaa" }],
    ["missing apiKey", { apiBaseUrl: "https://api-dev.cognigy.ai" }],
    [
      "numeric apiKey",
      { apiBaseUrl: "https://api-dev.cognigy.ai", apiKey: 123 },
    ],
    ["null apiBaseUrl", { apiBaseUrl: null, apiKey: "test-key-aaaa" }],
    ["numeric endpointBaseUrl", { ...GOOD, endpointBaseUrl: 5 }],
    ["object versionHint", { ...GOOD, versionHint: {} }],
    ["numeric versionHint", { ...GOOD, versionHint: 4 }],
    ["boolean webchatBaseUrl", { ...GOOD, webchatBaseUrl: true }],
    ["array staticFilesBaseUrl", { ...GOOD, staticFilesBaseUrl: ["x"] }],
  ])(
    "drops a profile that is %s, reports it as a problem, and keeps the valid sibling",
    (label, bad) => {
      const result = readUserProfilesFile(
        writeJson({ profiles: { bad, good: GOOD } }),
      );
      eq(
        result.profiles,
        { good: GOOD },
        `readUserProfilesFile(profile entry ${label})`,
        "B-malformed: malformed entries are kept out of profiles, not thrown",
        "Remove only the malformed profile; keep valid profiles and do not throw.",
      );
      const reported = result.problems.filter((p) => p.name === "bad");
      ok(
        result.problems.length === 1 &&
          reported.length === 1 &&
          reported[0].reason.length > 0 &&
          !reported[0].reason.includes("test-key-aaaa"),
        `readUserProfilesFile(profile entry ${label}) problems`,
        "G: malformed entries are reported, not silently dropped",
        'exactly one problem named "bad" with a non-empty reason containing no key value',
        JSON.stringify(result.problems),
        "Record a safe reason for every dropped profile entry.",
      );
      ok(
        !("bad" in result.profiles),
        `readUserProfilesFile(profile entry ${label}) drops "bad"`,
        "B-malformed: a dropped entry must be absent",
        'no "bad" key',
        `keys: ${Object.keys(result.profiles).join(",")}`,
        "Do not keep half-valid profiles.",
      );
    },
  );
});

describe("readUserProfilesFile: prototype safety", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "ignores a profile named %s",
    (name) => {
      // Raw text: JSON.parse creates an OWN "__proto__" property here.
      const text = `{"profiles":{"${name}":{"apiBaseUrl":"https://x.test","apiKey":"test-key-evil"},"ok":{"apiBaseUrl":"https://api-dev.cognigy.ai","apiKey":"test-key-aaaa"}}}`;
      const result = readUserProfilesFile(writeRaw(text));
      eq(
        Object.keys(result.profiles),
        ["ok"],
        `readUserProfilesFile(profile named ${name})`,
        "B-proto: dangerous names are ignored",
        "Never expose a profile under a prototype-related name.",
      );
      // Reserved names may be silently ignored or reported; either is acceptable,
      // but a problem may only ever concern a reserved name, never "ok".
      ok(
        result.problems.every((p) =>
          ["__proto__", "constructor", "prototype"].includes(p.name),
        ),
        `readUserProfilesFile(profile named ${name}) problems`,
        "G: reserved names are ignored or reported, valid siblings are not",
        "no problem for the valid sibling",
        JSON.stringify(result.problems),
        "Do not flag valid profiles because a reserved name is present.",
      );
      ok(
        Object.getPrototypeOf(result.profiles) === Object.prototype,
        `readUserProfilesFile(profile named ${name}) prototype`,
        "B-proto: profiles must be a plain, uninherited map",
        "Object.getPrototypeOf(profiles) === Object.prototype",
        "prototype was replaced",
        "Do not assign dangerous keys onto the result map.",
      );
      eq(
        (result.profiles as Record<string, unknown>).apiKey,
        undefined,
        `readUserProfilesFile(profile named ${name}) inherited apiKey`,
        "B-proto: no inherited properties",
        "The result map must not inherit profile fields.",
      );
      eq(
        ({} as Record<string, unknown>).apiKey,
        undefined,
        `readUserProfilesFile(profile named ${name}) global pollution`,
        "B-proto: Object.prototype must stay clean",
        "Never write onto Object.prototype.",
      );
    },
  );

  it("ignores __proto__, constructor and prototype as profile FIELD names", () => {
    const text =
      '{"profiles":{"dev":{"apiBaseUrl":"https://api-dev.cognigy.ai","apiKey":"test-key-aaaa","__proto__":{"polluted":"yes"},"constructor":"c","prototype":"p"}}}';
    const result = readUserProfilesFile(writeRaw(text));
    const dev = result.profiles.dev as unknown as Record<string, unknown>;
    eq(
      Object.keys(dev).sort(),
      ["apiBaseUrl", "apiKey"],
      "readUserProfilesFile(profile with dangerous field names)",
      "B-proto: dangerous field names are ignored",
      "Copy only the documented fields onto the profile.",
    );
    ok(
      Object.getPrototypeOf(dev) === Object.prototype,
      "readUserProfilesFile(profile with __proto__ field) prototype",
      "B-proto: profile objects must be plain",
      "Object.getPrototypeOf(profile) === Object.prototype",
      "prototype was replaced",
      "Do not let a __proto__ field alter the profile prototype.",
    );
    eq(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "readUserProfilesFile(profile with __proto__ field) global pollution",
      "B-proto: Object.prototype must stay clean",
      "Never merge untrusted objects onto prototypes.",
    );
  });
});

describe("existing flat-string reader stays compatible (readUserConfigFile)", () => {
  it("returns only string values, ignoring the profiles object, and includes the string defaultProfile", () => {
    const file = writeJson({
      COGNIGY_API_BASE_URL: "https://api-trial.cognigy.ai",
      COGNIGY_API_KEY: "test-key-legacy",
      defaultProfile: "dev",
      profiles: { dev: GOOD },
    });
    eq(
      readUserConfigFile(file),
      {
        COGNIGY_API_BASE_URL: "https://api-trial.cognigy.ai",
        COGNIGY_API_KEY: "test-key-legacy",
        defaultProfile: "dev",
      },
      "readUserConfigFile(file with profiles)",
      "B-compat: older engines read the same file and must ignore the profiles object",
      "The flat reader keeps string entries (including defaultProfile) and drops non-string entries such as profiles.",
    );
    expect(Object.keys(readUserConfigFile(file))).not.toContain("profiles");
  });
});
