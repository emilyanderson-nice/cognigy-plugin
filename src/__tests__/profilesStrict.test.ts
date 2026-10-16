import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readUserConfigFile } from "../userConfigFile.js";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import {
  ProfileConfigError,
  loadProfilesFromSystem,
} from "../profiles/profiles.js";
import { eq, ok, raises } from "./helpers/specAssert.js";

const KEY = "fake-key-STRICT-distinct-9";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "strict-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (content: string): string => {
  const p = join(dir, "config.json");
  writeFileSync(p, content, "utf-8");
  return p;
};
const dirAsFile = (): string => {
  const p = join(dir, "config.json");
  mkdirSync(p);
  return p;
};

type Reader = (path: string, opts?: { strict?: boolean }) => unknown;
const READERS: Array<[string, Reader, unknown]> = [
  ["readUserConfigFile", readUserConfigFile as Reader, {}],
  [
    "readUserProfilesFile",
    readUserProfilesFile as Reader,
    { profiles: {}, problems: [] },
  ],
];

function strictFailure(read: Reader, path: string, what: string): Error {
  return raises(
    () => read(path, { strict: true }),
    ProfileConfigError,
    what,
    "F1: strict mode fails closed with ProfileConfigError",
    "Throw ProfileConfigError instead of reporting 'nothing configured'.",
  );
}
function cleanMessage(message: string, what: string, extra: string[]): void {
  for (const bad of [dir, KEY, ...extra])
    ok(
      !message.includes(bad),
      what,
      "F1: message never contains the full path, file content or a key",
      "fixed text naming only the base name (and code)",
      message,
      "Name only the file's base name and error code.",
    );
}

describe.each(READERS)("%s strict mode", (name, read, empty) => {
  it("F1: non-strict behaviour is unchanged (directory, bad JSON, non-object all give the empty result)", () => {
    const p = dirAsFile();
    eq(
      read(p),
      empty,
      `${name} non-strict directory`,
      "F1: existing non-strict behaviour kept",
      "Keep swallowing errors when strict is not requested.",
    );
    for (const text of ["{ nope", "[1,2]", '"s"', "null", ""]) {
      rmSync(p, { recursive: true, force: true });
      file(text);
      eq(
        read(p),
        empty,
        `${name} non-strict ${JSON.stringify(text)}`,
        "F1: existing non-strict behaviour kept",
        "Keep returning the empty result for malformed content.",
      );
      eq(
        read(p, { strict: false }),
        empty,
        `${name} strict:false ${JSON.stringify(text)}`,
        "F1: strict:false equals default",
        "Treat strict:false like the default.",
      );
    }
  });

  it("F1: ENOENT gives the same empty result as non-strict", () => {
    eq(
      read(join(dir, "missing.json"), { strict: true }),
      empty,
      `${name} strict ENOENT`,
      "F1: a missing file is simply 'nothing configured'",
      "Only a missing file may produce the empty result in strict mode.",
    );
  });

  it("F1: a non-ENOENT fs error (EISDIR) throws a fixed message naming base name and code only", () => {
    const e = strictFailure(read, dirAsFile(), `${name} EISDIR`);
    ok(
      e.message.includes("config.json") && e.message.includes("EISDIR"),
      `${name} EISDIR message`,
      "F1: message names the file base name and the error code",
      "text containing 'config.json' and 'EISDIR'",
      e.message,
      "Include the base name and the fs error code.",
    );
    cleanMessage(e.message, `${name} EISDIR message`, []);
  });

  it.each([
    ["invalid JSON", `{"apiKey":"${KEY}" oops`],
    ["empty file", ""],
    ["top-level array", `["${KEY}"]`],
    ["top-level string", `"${KEY}"`],
    ["top-level null", "null"],
    ["top-level number", "42"],
  ])("F1: %s throws ProfileConfigError without echoing content", (_n, text) => {
    const e = strictFailure(read, file(text), `${name} ${_n}`);
    cleanMessage(e.message, `${name} ${_n} message`, [
      ...(text.length >= 8 ? [text.slice(1)] : []),
    ]);
  });

  it("F1: a UTF-8 BOM is still tolerated in strict mode", () => {
    const p = file("﻿{}");
    eq(
      read(p, { strict: true }),
      empty,
      `${name} BOM`,
      "F1: BOM-prefixed valid JSON parses",
      "Strip a leading BOM before parsing.",
    );
  });
});

describe("strict readers keep real content", () => {
  it("F1: valid content is read identically in strict and non-strict mode", () => {
    const p = file(
      JSON.stringify({
        COGNIGY_API_KEY: KEY,
        defaultProfile: "a",
        profiles: {
          a: { apiBaseUrl: "https://api-a.cognigy.ai", apiKey: KEY },
        },
      }),
    );
    eq(
      readUserConfigFile(p, { strict: true }),
      readUserConfigFile(p),
      "strict config read",
      "F1: strict does not change successful reads",
      "Return the same data when the file is fine.",
    );
    eq(
      readUserProfilesFile(p, { strict: true }),
      readUserProfilesFile(p),
      "strict profiles read",
      "F1: strict does not change successful reads",
      "Return the same data when the file is fine.",
    );
    eq(
      Object.keys(readUserProfilesFile(p, { strict: true }).profiles),
      ["a"],
      "strict profiles content",
      "F1: profile a is read",
      "Parse profiles normally in strict mode.",
    );
  });
});

describe("loadProfilesFromSystem strict", () => {
  it("F1: injected readers are used as given, even with strict: true", () => {
    const readLegacyFile = jest.fn(() => ({}) as Record<string, string>);
    const readProfilesFile = jest.fn(() => ({
      profiles: {
        a: { apiBaseUrl: "https://api-a.cognigy.ai", apiKey: KEY },
      },
      problems: [],
    }));
    const set = loadProfilesFromSystem({
      env: {},
      strict: true,
      readLegacyFile,
      readProfilesFile,
    });
    eq(
      [
        set.profiles.map((p) => p.name),
        readLegacyFile.mock.calls.length,
        readProfilesFile.mock.calls.length,
      ],
      [["a"], 1, 1],
      "injected readers with strict",
      "F1: injected readers are called once and their data used",
      "Honour injected readers regardless of strict.",
    );
  });

  it("F1: an injected reader that throws propagates (no swallowing)", () => {
    raises(
      () =>
        loadProfilesFromSystem({
          env: {},
          strict: true,
          readProfilesFile: () => {
            throw new ProfileConfigError("boom");
          },
        }),
      ProfileConfigError,
      "throwing injected reader",
      "F1: strict loading does not hide reader failures",
      "Let reader errors surface so the registry can fail closed.",
    );
  });
});
