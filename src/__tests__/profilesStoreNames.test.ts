import { describe, it, afterEach } from "@jest/globals";
import { join } from "path";
import { writeFileSync } from "fs";
import { ProfileConfigError } from "../profiles/profiles.js";
import type { RawFileProfile } from "../profiles/profilesFile.js";
import {
  removeProfile,
  setDefaultProfile,
  upsertProfile,
} from "../profiles/profilesStore.js";
import {
  cleanupTmp,
  freshDir,
  readJson,
  recorder,
} from "./helpers/configFixtures.js";
import { eq, raises } from "./helpers/specAssert.js";

afterEach(cleanupTmp);

const A: RawFileProfile = {
  apiBaseUrl: "https://a.test",
  apiKey: "fake-key-a",
};
const B: RawFileProfile = {
  apiBaseUrl: "https://b.test",
  apiKey: "fake-key-b",
};
const C: RawFileProfile = {
  apiBaseUrl: "https://c.test",
  apiKey: "fake-key-c",
  versionHint: "v4",
};

function seed(content: object): {
  path: string;
  opts: never;
} {
  const path = join(freshDir(), "config.json");
  writeFileSync(path, JSON.stringify(content));
  return {
    path,
    opts: { path, platform: "win32", run: recorder().run } as never,
  };
}

describe("H6: removeProfile looks up the name as given, then canonically", () => {
  it("removes a malformed legacy 'Prod' entry and returns true", () => {
    const s = seed({ profiles: { Prod: A, dev: B } });
    eq(
      removeProfile("Prod", s.opts),
      true,
      "removeProfile('Prod')",
      "H6: a non-canonical legacy entry is removable by its stored name",
      "Match the name exactly as stored before trying the canonical form.",
    );
    eq(
      readJson(s.path),
      { profiles: { dev: B } },
      "removeProfile('Prod') content",
      "H6: only that entry is deleted",
      "Delete the matching profile and keep the rest.",
    );
  });

  it.each([
    ["defaultProfile equals the given spelling", "Prod"],
    ["defaultProfile equals the canonical spelling", "prod"],
  ])("deletes defaultProfile when %s", (_label, def) => {
    const s = seed({
      defaultProfile: def,
      K: "v",
      profiles: { Prod: A, dev: B },
    });
    removeProfile("Prod", s.opts);
    eq(
      readJson(s.path),
      { K: "v", profiles: { dev: B } },
      `removeProfile('Prod') with defaultProfile ${def}`,
      "H6: defaultProfile pointing at either spelling of the removed profile is deleted",
      "Never leave defaultProfile referring to a removed profile under either spelling.",
    );
  });

  it("keeps an unrelated defaultProfile", () => {
    const s = seed({ defaultProfile: "dev", profiles: { Prod: A, dev: B } });
    removeProfile("Prod", s.opts);
    eq(
      readJson(s.path),
      { defaultProfile: "dev", profiles: { dev: B } },
      "removeProfile('Prod') unrelated default",
      "H6: only a default that refers to the removed profile is deleted",
      "Preserve defaultProfile when it names another profile.",
    );
  });

  it("an exact-name match wins over the canonical form", () => {
    const s = seed({ profiles: { Prod: A, prod: B } });
    removeProfile("Prod", s.opts);
    eq(
      readJson(s.path),
      { profiles: { prod: B } },
      "removeProfile('Prod') with both spellings",
      "H6: the given spelling is looked up first and removed alone",
      "Remove exactly the entry named as given when it exists.",
    );
  });

  it.each([["V4_STAGING"], ["v4_staging"], ["V4-Staging"]])(
    "falls back to the canonical form: %j removes 'v4-staging'",
    (given) => {
      const s = seed({ profiles: { "v4-staging": A, dev: B } });
      eq(
        removeProfile(given, s.opts),
        true,
        `removeProfile(${given})`,
        "H6: canonical fallback (lowercase, _ to -)",
        "Try the canonical spelling when the given name is not present.",
      );
      eq(
        readJson(s.path),
        { profiles: { dev: B } },
        `removeProfile(${given}) content`,
        "H6: canonical entry removed",
        "Remove the canonical entry.",
      );
    },
  );
});

describe("H6: setDefaultProfile looks up the name as given, then canonically", () => {
  it("setDefaultProfile('Prod') selects exactly the stored 'Prod'", () => {
    const s = seed({ profiles: { Prod: A, dev: B } });
    setDefaultProfile("Prod", s.opts);
    eq(
      readJson(s.path),
      { defaultProfile: "Prod", profiles: { Prod: A, dev: B } },
      "setDefaultProfile('Prod')",
      "H6: the stored spelling is selected, not a lowercased guess",
      "Store the profile's name exactly as it exists in the file.",
    );
  });

  it("an exact match wins when both 'Prod' and 'prod' exist", () => {
    const s = seed({ profiles: { Prod: A, prod: B } });
    setDefaultProfile("Prod", s.opts);
    eq(
      (readJson(s.path) as { defaultProfile: string }).defaultProfile,
      "Prod",
      "setDefaultProfile('Prod') with both",
      "H6: given spelling is tried first",
      "Prefer the exact name over its canonical form.",
    );
  });

  it("still normalises when only the canonical form exists", () => {
    const s = seed({ profiles: { "v4-staging": A } });
    setDefaultProfile("V4_STAGING", s.opts);
    eq(
      (readJson(s.path) as { defaultProfile: string }).defaultProfile,
      "v4-staging",
      "setDefaultProfile('V4_STAGING')",
      "H6/5: canonical fallback",
      "Fall back to lowercase with underscores as hyphens.",
    );
  });

  it("still rejects a name that matches neither spelling", () => {
    const s = seed({ profiles: { Prod: A } });
    raises(
      () => setDefaultProfile("ghost", s.opts),
      ProfileConfigError,
      "setDefaultProfile('ghost')",
      "5: unknown names are rejected",
      "Reject names that are not in the file.",
    );
  });
});

describe("H6: upsertProfile keeps strict names", () => {
  it.each([["Prod"], ["V4_STAGING"], ["my_dev"]])(
    "rejects non-canonical %j: the CLI must normalise the name before calling upsertProfile",
    (name) => {
      const s = seed({ profiles: {} });
      raises(
        () => upsertProfile(name, A, s.opts),
        ProfileConfigError,
        `upsertProfile(${name})`,
        "H6/1: upsert accepts only /^[a-z0-9][a-z0-9-]*$/ names",
        "Reject non-canonical names; callers normalise first.",
      );
    },
  );
});

describe("H8: upsertProfile replaces the whole profile", () => {
  it("fields not supplied in the replacement are removed, not merged from the old profile", () => {
    const full: RawFileProfile = {
      apiBaseUrl: "https://old.test",
      apiKey: "fake-key-old",
      endpointBaseUrl: "https://ep.old.test",
      webchatBaseUrl: "https://wc.old.test",
      staticFilesBaseUrl: "https://st.old.test",
      versionHint: "v4",
    };
    const s = seed({ profiles: { dev: full, other: C } });
    const result = upsertProfile("dev", B, s.opts);
    eq(
      [result, readJson(s.path)],
      [{ created: false }, { profiles: { dev: B, other: C } }],
      "upsertProfile(replace drops unsupplied fields)",
      "H8: replacement is whole-profile, no field-level merge",
      "Write exactly the supplied fields; remove every optional field that was not supplied.",
    );
  });
});
