/**
 * The legacy fields and the named profiles live in the same credential file.
 * If they were read separately, an atomic replace between the two reads would
 * produce a profile set built from two versions of the file — a snapshot that
 * never existed. The file is replaced after every read here to prove the
 * loader derives both sections from one read.
 */
import { describe, expect, it, jest } from "@jest/globals";

const actualFs = jest.requireActual<typeof import("fs")>("fs");
let versions: string[] = [];
let configReads = 0;
let configPath = "";

jest.unstable_mockModule("fs", () => ({
  ...actualFs,
  default: actualFs,
  readFileSync: (path: unknown, ...rest: unknown[]) => {
    if (path === configPath) {
      // Each read sees the next version: the file was replaced in between.
      const text = versions[Math.min(configReads, versions.length - 1)];
      configReads += 1;
      return text;
    }
    return (actualFs.readFileSync as (...a: unknown[]) => unknown)(
      path,
      ...rest,
    );
  },
}));

const { USER_CONFIG_FILE } = await import("../userConfigFile.js");
const { loadProfilesFromSystem } = await import("../profiles/profiles.js");

const BEFORE = JSON.stringify({
  COGNIGY_API_BASE_URL: "https://api-before.cognigy.ai",
  COGNIGY_API_KEY: "fake-key-BEFORE-0001",
});
const AFTER = JSON.stringify({
  profiles: {
    after: {
      apiBaseUrl: "https://api-after.cognigy.ai",
      apiKey: "fake-key-AFTER-0002",
    },
  },
});

const load = (strict: boolean) => {
  configPath = USER_CONFIG_FILE;
  configReads = 0;
  return loadProfilesFromSystem({ env: {}, strict });
};

describe("loadProfilesFromSystem reads the credential file once", () => {
  it.each([true, false])(
    "replacement during loading never mixes two versions (strict: %s)",
    (strict) => {
      versions = [BEFORE, AFTER];
      const set = load(strict);
      expect(set.profiles.map((p) => p.name)).toEqual(["default"]);
      expect(configReads).toBe(1);

      versions = [AFTER, BEFORE];
      expect(load(strict).profiles.map((p) => p.name)).toEqual(["after"]);
    },
  );
});
