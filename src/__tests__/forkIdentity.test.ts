import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

import * as forkIdentity from "../install/forkIdentity.js";

const { getEngineSpec, FORK_MARKETPLACE_NAME, FORK_PLUGIN_ID, FORK_REPO } =
  forkIdentity;

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toBe(expected);
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

const pkgVersion: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;

describe("forkIdentity", () => {
  it("FORK_REPO is the fork's GitHub owner/repo", () => {
    check(
      "FORK_REPO",
      "Installer must point at the fork repository",
      "emilyanderson-nice/cognigy-plugin",
      FORK_REPO,
      "Export FORK_REPO from src/install/forkIdentity.ts with the fork's owner/repo slug.",
    );
  });

  it("FORK_MARKETPLACE_NAME is cognigy-plugin-v2", () => {
    check(
      "FORK_MARKETPLACE_NAME",
      "The fork's marketplace name must differ from upstream's",
      "cognigy-plugin-v2",
      FORK_MARKETPLACE_NAME,
      "Export FORK_MARKETPLACE_NAME from src/install/forkIdentity.ts.",
    );
  });

  it("FORK_PLUGIN_ID is cognigy@cognigy-plugin-v2", () => {
    check(
      "FORK_PLUGIN_ID",
      "Plugin id is <plugin>@<marketplace> for the fork's marketplace",
      "cognigy@cognigy-plugin-v2",
      FORK_PLUGIN_ID,
      "Export FORK_PLUGIN_ID from src/install/forkIdentity.ts.",
    );
  });

  it("FORK_PLUGIN_ID is cognigy@ followed by FORK_MARKETPLACE_NAME", () => {
    check(
      "FORK_PLUGIN_ID derivation",
      "Plugin id must track the marketplace name constant",
      `cognigy@${FORK_MARKETPLACE_NAME}`,
      FORK_PLUGIN_ID,
      "Build FORK_PLUGIN_ID as `cognigy@${FORK_MARKETPLACE_NAME}`.",
    );
  });

  it("getEngineSpec() pins the fork's github tag matching package.json version", () => {
    check(
      "typeof getEngineSpec",
      "The engine pin is exposed as a function, not a constant",
      "function",
      typeof getEngineSpec,
      "Export a function getEngineSpec(): string from src/install/forkIdentity.ts.",
    );
    const spec = getEngineSpec();
    check(
      "getEngineSpec()",
      "Engine pin must follow the release version in package.json",
      `github:emilyanderson-nice/cognigy-plugin#v${pkgVersion}`,
      spec,
      "Derive the pin from the package.json version field (not a hard-coded number).",
    );
    check(
      "getEngineSpec() format",
      "Pin has the github:owner/repo#vX.Y.Z shape",
      true,
      /^github:emilyanderson-nice\/cognigy-plugin#v\d+\.\d+\.\d+/.test(spec),
      "Return github:<repo>#v<semver>.",
    );
  });

  it("no constant ENGINE_SPEC export remains", () => {
    check(
      "ENGINE_SPEC export",
      "The eager constant is replaced by getEngineSpec()",
      false,
      "ENGINE_SPEC" in forkIdentity,
      "Remove the ENGINE_SPEC export; read package.json lazily inside getEngineSpec().",
    );
  });
});
