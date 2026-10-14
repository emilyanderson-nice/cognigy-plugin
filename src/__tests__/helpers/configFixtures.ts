import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type RunResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};
export type Runner = (command: string, args: string[]) => RunResult;
export type Call = { command: string; args: string[] };

const tmpDirs: string[] = [];
/** A fresh temp directory (never the real home). Pair with cleanupTmp() in afterEach. */
export function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-cfgfix-"));
  tmpDirs.push(dir);
  return dir;
}
export function cleanupTmp(): void {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
}
export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Fake command runner. whoami always fails (so the env-name fallback user is
 * used) and is not recorded; `calls` holds icacls invocations only.
 * `onCall` runs just before each icacls result is returned (n is 1-based).
 */
export function recorder(
  onCall?: (n: number, call: Call) => number | null | void,
): { calls: Call[]; run: Runner } {
  const calls: Call[] = [];
  const run: Runner = (command, args) => {
    if (command === "whoami") return { status: 1 };
    const call = { command, args: [...args] };
    calls.push(call);
    const status = onCall?.(calls.length, call);
    return { status: status === undefined ? 0 : status };
  };
  return { calls, run };
}

export function codeError(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}
