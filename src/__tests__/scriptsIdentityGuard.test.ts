import { describe, it, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";

const SCRIPTS_DIR = join(process.cwd(), "scripts");
const IDENTITY_FILE = "fork-identity.mjs";
const IDENTITY_PATH = join(SCRIPTS_DIR, IDENTITY_FILE);
const IDENTITY_URL = pathToFileURL(IDENTITY_PATH).href;

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

function scriptFiles(): string[] {
  if (!existsSync(SCRIPTS_DIR)) return [];
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
}

const guardedFiles = scriptFiles().filter((f) => f !== IDENTITY_FILE);

function evalInIdentity(expression: string): unknown {
  const code = `import(${JSON.stringify(IDENTITY_URL)}).then(m=>console.log(JSON.stringify(${expression})))`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: loading scripts/fork-identity.mjs in a child node process",
        "2. REQUIREMENT VIOLATED: fork-identity.mjs is the single importable home of the fork identity constants",
        `3. EXPECTED: exit status 0 for expression ${expression}`,
        `4. ACTUAL: status ${r.status}; stderr first line: ${(r.stderr ?? "").split("\n")[0]}`,
        "5. GUIDANCE: Ensure scripts/fork-identity.mjs exists and is a valid ES module exporting the legacy identity constants.",
      ].join("\n"),
    );
  }
  return JSON.parse(r.stdout.trim());
}

describe("scripts/ identity guard", () => {
  it("scripts/ has at least 6 .mjs files besides fork-identity.mjs and fork-identity.mjs exists", () => {
    check(
      "scripts/fork-identity.mjs exists",
      "The fork identity lives in exactly one module",
      true,
      existsSync(IDENTITY_PATH),
      "Keep scripts/fork-identity.mjs in place.",
    );
    check(
      "scripts glob finds enough files",
      "The guard must actually scan the scripts directory (a wrong glob would pass vacuously)",
      true,
      guardedFiles.length >= 6,
      `Found only ${guardedFiles.length} files; the scan must list scripts/*.mjs excluding fork-identity.mjs.`,
    );
  });

  it.each([
    "pb-crackers",
    "cognigy-plugin-pb",
    "emilyanderson-nice",
    "cognigy-plugin-v2",
  ])(
    "no scripts/*.mjs other than fork-identity.mjs contains %s",
    (forbidden) => {
      const offenders = guardedFiles.filter((f) =>
        readFileSync(join(SCRIPTS_DIR, f), "utf8").includes(forbidden),
      );
      check(
        `scripts hard-code "${forbidden}"`,
        "Fork identity strings must live only in scripts/fork-identity.mjs; other scripts import them",
        [],
        offenders,
        `Remove the literal "${forbidden}" from each listed file and import the equivalent constant from fork-identity.mjs (or avoid naming it at all).`,
      );
    },
  );

  it("fork-identity.mjs exports LEGACY_FORK_REPO", () => {
    check(
      "LEGACY_FORK_REPO",
      "The previous fork's slug is recorded centrally for migration",
      "pb-crackers/cognigy-plugin",
      evalInIdentity("m.LEGACY_FORK_REPO"),
      "Export LEGACY_FORK_REPO from scripts/fork-identity.mjs with the previous fork's owner/repo.",
    );
  });

  it("fork-identity.mjs exports LEGACY_MARKETPLACE_NAME", () => {
    check(
      "LEGACY_MARKETPLACE_NAME",
      "The previous fork's marketplace name is recorded centrally for migration",
      "cognigy-plugin-pb",
      evalInIdentity("m.LEGACY_MARKETPLACE_NAME"),
      "Export LEGACY_MARKETPLACE_NAME from scripts/fork-identity.mjs with the previous marketplace name.",
    );
  });

  it("resolve-upstream-merge.mjs uses the merge-resolution module", () => {
    const path = join(SCRIPTS_DIR, "resolve-upstream-merge.mjs");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    check(
      "resolve-upstream-merge.mjs references merge-resolution.mjs",
      "Conflict resolution logic is shared via scripts/merge-resolution.mjs, not duplicated inline",
      true,
      text.includes("merge-resolution.mjs"),
      "Import the resolution function from ./merge-resolution.mjs in resolve-upstream-merge.mjs.",
    );
  });
});
