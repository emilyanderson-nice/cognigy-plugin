import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";

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

const SCRIPT_URL = pathToFileURL(
  join(process.cwd(), "scripts", "fork-identity.mjs"),
).href;

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

  it("ENGINE_NPX_FLAGS is exactly ['--allow-git=root']", () => {
    const flags = (forkIdentity as unknown as Record<string, unknown>)
      .ENGINE_NPX_FLAGS;
    check(
      "ENGINE_NPX_FLAGS",
      "npm 12 blocks github: specs unless git is allowed for the root package; the installers must pass this flag",
      JSON.stringify(["--allow-git=root"]),
      JSON.stringify(flags ?? null),
      "Export ENGINE_NPX_FLAGS from src/install/forkIdentity.ts as an array holding only the allow-git=root flag.",
    );
  });

  it("ENGINE_NPX_FLAGS equals the constant exported by scripts/fork-identity.mjs", () => {
    const code = `import(${JSON.stringify(SCRIPT_URL)}).then(m=>console.log(JSON.stringify(m.ENGINE_NPX_FLAGS ?? null)))`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    const mjsFlags = r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
    const tsFlags = JSON.stringify(
      (forkIdentity as unknown as Record<string, unknown>).ENGINE_NPX_FLAGS ??
        null,
    );
    check(
      "ENGINE_NPX_FLAGS twin equality",
      "The build-time script and the installer must pass the same npx flags, or manifests and installs would disagree",
      mjsFlags,
      tsFlags,
      "Make src/install/forkIdentity.ts and scripts/fork-identity.mjs export the same ENGINE_NPX_FLAGS value (both must be defined).",
    );
    check(
      "ENGINE_NPX_FLAGS twin is defined",
      "Equality of two missing values is not agreement",
      JSON.stringify(["--allow-git=root"]),
      mjsFlags,
      "Define ENGINE_NPX_FLAGS in scripts/fork-identity.mjs.",
    );
  });

  it("forkIdentity.ts exports only the flags constant, not a launch-args function", () => {
    check(
      "engineLaunchArgs export in forkIdentity.ts",
      "The TypeScript side exposes only the flag constant; the launch-args builder lives in the script module",
      false,
      "engineLaunchArgs" in forkIdentity,
      "Do not export engineLaunchArgs from src/install/forkIdentity.ts.",
    );
  });

  it("SETUP_COMMAND is the exact flagged fork setup command", () => {
    check(
      "SETUP_COMMAND",
      "The command users are told to run must carry --allow-git=root first, then -y, for npm 12",
      "npx --allow-git=root -y -p github:emilyanderson-nice/cognigy-plugin cognigy-setup",
      (forkIdentity as unknown as Record<string, unknown>)
        .SETUP_COMMAND as string,
      "Export SETUP_COMMAND from src/install/forkIdentity.ts with exactly that text.",
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
