import { describe, it, expect, jest } from "@jest/globals";
import * as realFs from "node:fs";

jest.unstable_mockModule("node:fs", () => ({
  ...realFs,
  default: realFs,
  readFileSync: () => {
    throw new Error("ENOENT: simulated");
  },
}));

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

describe("forkIdentity laziness", () => {
  it("importing never reads package.json; getEngineSpec() fails with package.json context", async () => {
    let mod: typeof import("../install/forkIdentity.js") | undefined;
    let importError: unknown;
    try {
      mod = await import("../install/forkIdentity.js");
    } catch (e) {
      importError = e;
    }
    check(
      "import with unreadable package.json",
      "Merely importing the module must not read package.json",
      undefined,
      importError === undefined ? undefined : String(importError),
      "Defer reading package.json until getEngineSpec() is called.",
    );
    check(
      "FORK_PLUGIN_ID after lazy import",
      "Identity constants stay available without package.json",
      "cognigy@cognigy-plugin-v2",
      mod?.FORK_PLUGIN_ID,
      "Keep FORK_PLUGIN_ID a plain constant independent of package.json.",
    );
    let thrown: Error | undefined;
    try {
      mod?.getEngineSpec();
    } catch (e) {
      thrown = e as Error;
    }
    check(
      "getEngineSpec() throws",
      "An unreadable package.json is an explicit error at call time",
      true,
      thrown instanceof Error,
      "Throw an Error from getEngineSpec() when package.json cannot be read.",
    );
    check(
      "getEngineSpec() message mentions package.json",
      "The error names the file that could not be read",
      true,
      (thrown?.message ?? "").includes("package.json"),
      "Wrap the underlying error with context naming package.json.",
    );
    check(
      "getEngineSpec() message adds context",
      "The error is more than the raw underlying error",
      true,
      thrown?.message !== "ENOENT: simulated",
      "Do not rethrow the raw error unchanged; add context.",
    );
  });
});
