import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const spawnSync = jest.fn<(...a: unknown[]) => unknown>();

// Mock both specifier spellings so the module under test is covered either way.
jest.unstable_mockModule("child_process", () => ({
  spawnSync,
  default: { spawnSync },
}));
jest.unstable_mockModule("node:child_process", () => ({
  spawnSync,
  default: { spawnSync },
}));

const { runCliTool } = await import("../install/cliRunner.js");

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

/** The options object is the last non-array object argument of the spawnSync call. */
function optionsOfFirstCall(): Record<string, unknown> | undefined {
  const call = spawnSync.mock.calls[0] ?? [];
  const objs = call.filter(
    (x) => typeof x === "object" && x !== null && !Array.isArray(x),
  );
  return objs[objs.length - 1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  spawnSync.mockReset().mockReturnValue({ status: 0, error: undefined });
});

describe("runCliTool optional fourth parameter", () => {
  it("with { timeoutMs: 5000 }: spawnSync options carry timeout 5000", () => {
    runCliTool("npx", "C:\\mock\\npx.cmd", ["-y", "x"], { timeoutMs: 5000 });
    check(
      "runCliTool timeout forwarded: spawnSync called",
      "runCliTool spawns exactly one process",
      1,
      spawnSync.mock.calls.length,
      "Call spawnSync once per runCliTool call.",
    );
    check(
      "runCliTool timeout forwarded: timeout option",
      "timeoutMs is passed to spawnSync as timeout",
      5000,
      optionsOfFirstCall()?.timeout,
      "Set options.timeout to opts.timeoutMs when it is provided.",
    );
  });

  it("with a timeout: stdio stays ignore/inherit/inherit", () => {
    runCliTool("npx", "C:\\mock\\npx.cmd", ["-y", "x"], { timeoutMs: 5000 });
    check(
      "runCliTool timeout: stdio",
      "Adding a timeout must not change how stdio is wired",
      ["ignore", "inherit", "inherit"],
      optionsOfFirstCall()?.stdio,
      "Keep stdio as ['ignore','inherit','inherit'] regardless of the 4th argument.",
    );
  });

  it("a different timeout value is forwarded as given", () => {
    runCliTool("npx", "C:\\mock\\npx.cmd", [], { timeoutMs: 180000 });
    check(
      "runCliTool timeout value 180000",
      "The timeout is not hard-coded",
      180000,
      optionsOfFirstCall()?.timeout,
      "Forward the caller's timeoutMs value.",
    );
  });

  it("without a fourth argument: options have no timeout key at all", () => {
    runCliTool("npx", "C:\\mock\\npx.cmd", ["-y", "x"]);
    const opts = optionsOfFirstCall();
    check(
      "runCliTool no opts: options object present",
      "Guard against a vacuous check: spawnSync received an options object",
      true,
      opts !== undefined,
      "Pass an options object to spawnSync.",
    );
    check(
      "runCliTool no opts: timeout key",
      "Existing callers keep unbounded behavior: no timeout key, not even undefined",
      false,
      opts !== undefined && "timeout" in opts,
      "Only add the timeout property when timeoutMs is provided.",
    );
    check(
      "runCliTool no opts: stdio",
      "Existing stdio wiring is unchanged",
      ["ignore", "inherit", "inherit"],
      opts?.stdio,
      "Keep stdio as ['ignore','inherit','inherit'].",
    );
  });

  it("with an empty options object: still no timeout key", () => {
    runCliTool("npx", "C:\\mock\\npx.cmd", [], {});
    const opts = optionsOfFirstCall();
    check(
      "runCliTool empty opts: timeout key",
      "An absent timeoutMs must not produce a timeout key",
      false,
      opts !== undefined && "timeout" in opts,
      "Add timeout only when opts.timeoutMs is defined.",
    );
  });
});
