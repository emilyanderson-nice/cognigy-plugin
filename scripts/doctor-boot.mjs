/**
 * Pure planning helpers for doctor's boot step: how to launch the engine, how
 * to kill its process tree, and what to say when it times out. Kept free of
 * side effects so they can be tested without spawning anything.
 */
import { FORK_VERSION_RE, engineLaunchArgs } from "./fork-identity.mjs";

/** How long doctor waits for the engine to answer; cold starts need minutes. */
export const BOOT_TIMEOUT_MS = 240000;

/**
 * How to spawn the engine. On Windows npx is npx.cmd, which Node refuses to
 * spawn without a shell. The args are constants without cmd.exe metacharacters
 * (& | < > ^ % space quote), so the unquoted concatenation is safe. Elsewhere
 * the child is detached so its whole process group can be killed.
 */
export function bootSpawnPlan(version, platform) {
  // The version reaches a shell on Windows; accept nothing but a fork version.
  if (typeof version !== "string" || !FORK_VERSION_RE.test(version)) {
    throw new Error(
      `Refusing to boot the engine: version "${String(version)}" is not a fork version (<base>-pb.<n>).`,
    );
  }
  const win = platform === "win32";
  return {
    command: "npx",
    args: engineLaunchArgs(version),
    options: win
      ? { shell: true, detached: false }
      : { shell: false, detached: true },
  };
}

/**
 * How to kill the engine and everything it spawned. Windows has no process
 * groups, so taskkill /T walks the tree; POSIX signals the negative pid.
 */
export function killPlan(platform, pid) {
  if (platform === "win32") {
    return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  return { signal: "SIGKILL", pid: -pid };
}

export function bootTimeoutMessage() {
  return `The engine did not respond within ${BOOT_TIMEOUT_MS / 1000}s. A cold start can take about 2 minutes; far beyond that usually means an install-time script is hung (see installScripts.test.ts).`;
}

/**
 * What to say when the engine process exits before answering. The stderr tail
 * is appended verbatim: it is the only place npm reports why (e.g. EALLOWGIT).
 */
export function bootExitMessage(code, signal, stderrTail) {
  const head =
    signal !== null && signal !== undefined
      ? `The engine exited due to signal ${signal} before it answered.`
      : `The engine exited with code ${code} before it answered.`;
  const tail = stderrTail ?? "";
  const lines = [head];
  if (tail.length > 0) lines.push(tail);
  if (tail.includes("EALLOWGIT")) {
    lines.push(
      'npm blocked the git spec. See the README section "Troubleshooting the first start".',
    );
  }
  return lines.join("\n");
}
