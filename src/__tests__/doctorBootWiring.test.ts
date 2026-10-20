import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

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

/**
 * scripts/doctor.mjs runs at top level (it boots the engine as soon as it is
 * imported), so it cannot be imported in a test. Its wiring is therefore checked
 * textually here, while the behaviour of every piece it calls is tested
 * against scripts/doctor-boot.mjs in doctorBoot.test.ts.
 */
const doctor = readFileSync(
  join(process.cwd(), "scripts", "doctor.mjs"),
  "utf8",
);

describe("scripts/doctor.mjs is wired to scripts/doctor-boot.mjs", () => {
  it("imports from ./doctor-boot.mjs", () => {
    check(
      "doctor.mjs imports doctor-boot.mjs",
      "doctor takes its spawn and kill plans from the testable pure module",
      true,
      /from\s+["']\.\/doctor-boot\.mjs["']/.test(doctor),
      'Add an import of bootSpawnPlan, killPlan and bootTimeoutMessage from "./doctor-boot.mjs".',
    );
  });

  it("no longer kills with POSIX-only process.kill(-proc.pid", () => {
    check(
      "doctor.mjs has no process.kill(-proc.pid",
      "A negative-pid kill leaks the process tree on Windows",
      false,
      doctor.includes("process.kill(-proc.pid"),
      "Kill through killPlan(platform, pid) instead of calling process.kill(-proc.pid ...) directly.",
    );
  });

  it("no longer spawns a hand-built npx call without the git flag", () => {
    check(
      'doctor.mjs has no spawn("npx", ["-y", "-p"',
      "The launch args must come from bootSpawnPlan, which carries --allow-git=root",
      false,
      doctor.includes('spawn("npx", ["-y", "-p"'),
      "Spawn using the command/args/options returned by bootSpawnPlan(version, process.platform).",
    );
  });

  it.each([
    [
      "bootSpawnPlan(",
      "the spawn command, args and options come from the plan",
    ],
    [
      "...plan.options",
      "the plan's options (shell/detached) are spread into spawn",
    ],
    ["killPlan(", "the tree kill comes from the platform-aware plan"],
    [
      "bootTimeoutMessage()",
      "the timeout message comes from the tested module",
    ],
    ["BOOT_TIMEOUT_MS", "the timer uses the shared timeout constant"],
    [
      "bootExitMessage(",
      "an early engine exit is reported by the tested message",
    ],
    ['.on("exit"', "the child's exit event is handled"],
    ['proc.stderr.on("data"', "stderr is captured to build the exit message"],
  ])("doctor.mjs contains %s", (needle, why) => {
    check(
      `doctor.mjs contains ${needle}`,
      why,
      true,
      doctor.includes(needle),
      `Use ${needle} in scripts/doctor.mjs: ${why}.`,
    );
  });

  it("does not hard-code the old 120000 ms timeout", () => {
    check(
      "doctor.mjs has no literal 120000",
      "The timer must use BOOT_TIMEOUT_MS so the constant and the message cannot drift apart",
      false,
      doctor.includes("120000"),
      "Replace the literal timeout with BOOT_TIMEOUT_MS from ./doctor-boot.mjs.",
    );
  });

  // Killing mutation: removing the stdin error listener (writing to a closed
  // pipe then crashes doctor with an unhandled 'error' event).
  it('listens for errors on the child stdin (proc.stdin.on("error")', () => {
    check(
      'doctor.mjs contains proc.stdin.on("error"',
      "Writing to a closed child pipe otherwise crashes doctor with an unhandled 'error' event",
      true,
      doctor.includes('proc.stdin.on("error"'),
      'Add proc.stdin.on("error", ...) that swallows or reports the error instead of crashing.',
    );
  });

  it("falls back to proc.kill when the taskkill result status is non-zero", () => {
    // Textual by necessity (see the header comment): the kill branch must
    // examine the taskkill result's .status and call proc.kill near kill.command.
    const at = doctor.indexOf("kill.command");
    const window = at < 0 ? "" : doctor.slice(Math.max(0, at - 300), at + 700);
    check(
      "doctor.mjs taskkill status fallback",
      "If taskkill fails (non-zero status) the engine must still be killed via proc.kill",
      { found: true, status: true, fallback: true },
      {
        found: at >= 0,
        status: window.includes(".status"),
        fallback: window.includes("proc.kill("),
      },
      "After running kill.command, check the result's .status and call proc.kill(...) when it is non-zero.",
    );
  });
});
