import { describe, it, expect, beforeEach } from "@jest/globals";
import { jest } from "@jest/globals";

type CliResult = { status: number | null; error?: Error };

const detectOnPath = jest.fn<(...a: unknown[]) => string | null>();
const runCliTool = jest.fn<(...a: unknown[]) => CliResult>();

jest.unstable_mockModule("../install/cliRunner.js", () => ({
  detectOnPath,
  runCliTool,
}));

const { buildPrewarmArgs, prewarmEngine } = await import(
  "../install/prewarm.js"
);

const SPEC = "github:emilyanderson-nice/cognigy-plugin#v1.22.0-pb.1";
const NPX_PATH = "C:\\mock\\bin\\npx.cmd";

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
  mode: "equal" | "contains" = "equal",
): void {
  try {
    if (mode === "contains") {
      expect(String(actual)).toContain(String(expected));
    } else {
      expect(actual).toEqual(expected);
    }
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED${mode === "contains" ? " (substring)" : ""}: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

beforeEach(() => {
  detectOnPath.mockReset().mockReturnValue(NPX_PATH);
  runCliTool.mockReset().mockReturnValue({ status: 0 });
});

describe("buildPrewarmArgs", () => {
  it("returns the exact npx argv that fetches the spec and runs a trivial node command", () => {
    check(
      "buildPrewarmArgs(spec)",
      "Prewarm argv installs the spec into the npx cache then runs node --version",
      ["-y", "-p", SPEC, "node", "--version"],
      buildPrewarmArgs(SPEC),
      "Return exactly -y, -p, the spec, node, --version in that order.",
    );
  });

  it("keeps the github pin spec intact, including the # and the tag", () => {
    check(
      "buildPrewarmArgs(github pin)",
      "A github:owner/repo#tag spec is passed through unchanged",
      [
        "-y",
        "-p",
        "github:emilyanderson-nice/cognigy-plugin#v1.22.0-pb.1",
        "node",
        "--version",
      ],
      buildPrewarmArgs("github:emilyanderson-nice/cognigy-plugin#v1.22.0-pb.1"),
      "Do not parse, escape or rewrite the spec.",
    );
  });

  it("places the supplied spec verbatim (different spec, different argv)", () => {
    check(
      "buildPrewarmArgs('other@1.0.0')",
      "The spec is interpolated as given, not hard-coded",
      ["-y", "-p", "other@1.0.0", "node", "--version"],
      buildPrewarmArgs("other@1.0.0"),
      "Use the spec parameter at the third position.",
    );
  });
});

describe("prewarmEngine: npx lookup", () => {
  it("npx missing: not ok, reason names npx, runner never called", () => {
    detectOnPath.mockReturnValue(null);
    const r = prewarmEngine(SPEC);
    check(
      "prewarmEngine npx missing: ok flag",
      "Without npx the prewarm cannot succeed",
      false,
      r.ok,
      "Return ok=false when detectOnPath('npx') yields null.",
    );
    check(
      "prewarmEngine npx missing: reason",
      "The reason tells the user npx was not found",
      "npx",
      r.reason,
      "Include the word npx in the reason.",
      "contains",
    );
    check(
      "prewarmEngine npx missing: runner calls",
      "No process is spawned when npx is absent",
      0,
      runCliTool.mock.calls.length,
      "Return before calling runCliTool.",
    );
    check(
      "prewarmEngine npx missing: lookup name",
      "The lookup is for the binary named npx",
      "npx",
      detectOnPath.mock.calls[0]?.[0],
      "Call detectOnPath with 'npx' as the first argument.",
    );
  });
});

describe("prewarmEngine: runner invocation", () => {
  it("calls runCliTool once with npx, the detected path, prewarm argv and a 180000 ms timeout", () => {
    prewarmEngine(SPEC);
    check(
      "prewarmEngine runner call",
      "One bounded runner call with the detected npx path",
      [
        [
          "npx",
          NPX_PATH,
          ["-y", "-p", SPEC, "node", "--version"],
          { timeoutMs: 180000 },
        ],
      ],
      runCliTool.mock.calls,
      "Call runCliTool exactly once as (npx, detectedPath, buildPrewarmArgs(spec), { timeoutMs: 180000 }).",
    );
  });

  it("passes the path that detectOnPath returned, not a hard-coded one", () => {
    detectOnPath.mockReturnValue("/usr/local/bin/npx");
    prewarmEngine(SPEC);
    check(
      "prewarmEngine uses detected path",
      "The second runner argument is the detected path",
      "/usr/local/bin/npx",
      runCliTool.mock.calls[0]?.[1],
      "Forward the detectOnPath result as the second runCliTool argument.",
    );
  });
});

describe("prewarmEngine: results", () => {
  it("status 0 and no error: exactly { ok: true }", () => {
    runCliTool.mockReturnValue({ status: 0 });
    check(
      "prewarmEngine success",
      "A clean exit is ok with no reason key",
      { ok: true },
      prewarmEngine(SPEC),
      "Return { ok: true } only, with no reason property.",
    );
  });

  it("non-zero status: not ok, reason non-empty and contains the status", () => {
    runCliTool.mockReturnValue({ status: 1 });
    const r = prewarmEngine(SPEC);
    check(
      "prewarmEngine non-zero: ok flag",
      "A failing exit is not ok",
      false,
      r.ok,
      "Return ok=false when status is not 0.",
    );
    check(
      "prewarmEngine non-zero: reason",
      "The reason carries the exit status",
      "1",
      r.reason,
      "Include the numeric exit status in the reason.",
      "contains",
    );
    check(
      "prewarmEngine non-zero: reason non-empty",
      "A reason is always provided on failure",
      true,
      typeof r.reason === "string" && r.reason.length > 0,
      "Provide a non-empty string reason.",
    );
  });

  it("a different non-zero status shows up in the reason", () => {
    runCliTool.mockReturnValue({ status: 127 });
    check(
      "prewarmEngine status 127: reason",
      "The reason reflects the actual status, not a constant",
      "127",
      prewarmEngine(SPEC).reason,
      "Interpolate the status from the runner result.",
      "contains",
    );
  });

  it("result.error set: not ok, reason contains the error message", () => {
    runCliTool.mockReturnValue({
      status: null,
      error: new Error("spawnSync npx ETIMEDOUT"),
    });
    const r = prewarmEngine(SPEC);
    check(
      "prewarmEngine error: ok flag",
      "A spawn error or timeout is not ok",
      false,
      r.ok,
      "Return ok=false when the runner result carries an error.",
    );
    check(
      "prewarmEngine error: reason",
      "The reason carries the error message",
      "spawnSync npx ETIMEDOUT",
      r.reason,
      "Include the error's message in the reason.",
      "contains",
    );
  });

  it("error set even when status is 0: still not ok", () => {
    runCliTool.mockReturnValue({ status: 0, error: new Error("boom-xyz") });
    const r = prewarmEngine(SPEC);
    check(
      "prewarmEngine status 0 with error: ok flag",
      "An error on the result always wins over a zero status",
      false,
      r.ok,
      "Treat any result.error as failure regardless of status.",
    );
    check(
      "prewarmEngine status 0 with error: reason",
      "The reason carries the error message",
      "boom-xyz",
      r.reason,
      "Include the error's message in the reason.",
      "contains",
    );
  });

  it("status null and no error (killed): not ok with a non-empty reason", () => {
    runCliTool.mockReturnValue({ status: null });
    const r = prewarmEngine(SPEC);
    check(
      "prewarmEngine killed: ok flag",
      "A process ended by a signal is not ok",
      false,
      r.ok,
      "Return ok=false when status is null.",
    );
    check(
      "prewarmEngine killed: reason",
      "A reason is always provided on failure",
      true,
      typeof r.reason === "string" && r.reason.length > 0,
      "Provide a non-empty string reason when status is null.",
    );
  });

  it("never throws when the runner throws; reason contains the thrown message", () => {
    runCliTool.mockImplementation(() => {
      throw new Error("runner exploded");
    });
    let r: { ok: boolean; reason?: string } | undefined;
    let threw: unknown;
    try {
      r = prewarmEngine(SPEC);
    } catch (e) {
      threw = e;
    }
    check(
      "prewarmEngine runner throws: no exception",
      "prewarmEngine is best-effort and must not propagate errors",
      undefined,
      threw,
      "Catch exceptions from runCliTool and convert them to a failure result.",
    );
    check(
      "prewarmEngine runner throws: ok flag",
      "A thrown runner is a failed prewarm",
      false,
      r?.ok,
      "Return ok=false when the runner throws.",
    );
    check(
      "prewarmEngine runner throws: reason",
      "The reason carries the thrown message",
      "runner exploded",
      r?.reason,
      "Include the thrown error's message in the reason.",
      "contains",
    );
  });

  it("never throws when detectOnPath throws", () => {
    detectOnPath.mockImplementation(() => {
      throw new Error("lookup exploded");
    });
    let r: { ok: boolean; reason?: string } | undefined;
    let threw: unknown;
    try {
      r = prewarmEngine(SPEC);
    } catch (e) {
      threw = e;
    }
    check(
      "prewarmEngine lookup throws: no exception",
      "prewarmEngine must never throw",
      undefined,
      threw,
      "Wrap the whole body, including the PATH lookup, in error handling.",
    );
    check(
      "prewarmEngine lookup throws: ok flag",
      "A failed lookup is a failed prewarm",
      false,
      r?.ok,
      "Return ok=false when the lookup throws.",
    );
  });
});
