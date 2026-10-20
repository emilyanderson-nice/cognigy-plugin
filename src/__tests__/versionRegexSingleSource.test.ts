import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

/**
 * Intent: the fork-version regex has ONE source of truth, FORK_VERSION_RE in
 * scripts/fork-identity.mjs. Other scripts import it. A capture-group PARSER
 * regex (fork-version.mjs splits base and counter) is allowed, but it must not
 * be a verbatim copy of FORK_VERSION_RE, which would be a second definition
 * that can drift.
 */

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

const read = (name: string): string =>
  readFileSync(join(process.cwd(), "scripts", name), "utf8");

/** Regex literals (/.../flags) in source that contain the text `-pb\.`. */
function pbRegexLiterals(src: string): string[] {
  const literals = src.match(/\/(?![/*])(?:\\.|[^/\\\n])+\/[a-z]*/g) ?? [];
  return literals.filter((l) => l.includes("-pb\\."));
}

/** True when the source imports `name` from "./fork-identity.mjs". */
function importsFromIdentity(src: string, name: string): boolean {
  const re = /import\s*\{([^}]*)\}\s*from\s*["']\.\/fork-identity\.mjs["']/g;
  for (const m of src.matchAll(re)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
    if (names.includes(name)) return true;
  }
  return false;
}

describe("FORK_VERSION_RE has a single definition", () => {
  // Killing mutation: removing or renaming the export in fork-identity.mjs.
  it("(a) scripts/fork-identity.mjs exports FORK_VERSION_RE as a RegExp", async () => {
    const mod: any = await import(
      pathToFileURL(join(process.cwd(), "scripts", "fork-identity.mjs")).href
    );
    check(
      "fork-identity.mjs exports FORK_VERSION_RE",
      "The one fork-version regex lives in fork-identity.mjs",
      true,
      mod.FORK_VERSION_RE instanceof RegExp,
      "export const FORK_VERSION_RE = /.../ from scripts/fork-identity.mjs.",
    );
  });

  // Killing mutation: release-tag.mjs defines its own /-pb\./ literal, or does
  // not import the shared one.
  it.each(["release-tag.mjs", "check-plugin-manifest.mjs"])(
    "(b/c) %s imports FORK_VERSION_RE and has no local -pb. regex literal",
    (file) => {
      const src = read(file);
      check(
        `${file} imports FORK_VERSION_RE from ./fork-identity.mjs`,
        "Scripts share one fork-version regex",
        true,
        importsFromIdentity(src, "FORK_VERSION_RE"),
        `Add FORK_VERSION_RE to the import { ... } from "./fork-identity.mjs" in ${file}.`,
      );
      check(
        `${file} has no local regex literal for the fork version`,
        "A second copy of the regex can drift from FORK_VERSION_RE",
        [],
        pbRegexLiterals(src),
        `Delete the local regex literal in ${file} and use FORK_VERSION_RE.`,
      );
    },
  );

  // Killing mutation: fork-version.mjs pastes FORK_VERSION_RE.source verbatim
  // as its own literal (a capture-group parser is still allowed).
  it("(d) fork-version.mjs does not copy FORK_VERSION_RE.source verbatim as a regex literal", async () => {
    const mod: any = await import(
      pathToFileURL(join(process.cwd(), "scripts", "fork-identity.mjs")).href
    );
    const source: string = mod.FORK_VERSION_RE.source;
    const src = read("fork-version.mjs");
    const literals = src.match(/\/(?![/*])(?:\\.|[^/\\\n])+\/[a-z]*/g) ?? [];
    const copies = literals.filter(
      (l) => l.slice(1, l.lastIndexOf("/")) === source,
    );
    check(
      "fork-version.mjs has no verbatim copy of FORK_VERSION_RE",
      "One source of truth for the fork-version pattern",
      [],
      copies,
      "Use FORK_VERSION_RE directly, or keep only a capture-group parser that differs from it.",
    );
  });
});
