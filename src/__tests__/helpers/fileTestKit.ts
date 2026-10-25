/**
 * Test-only helpers for the esc.4 file-access suites: temp ROOT directories
 * under os.tmpdir() (never the project dir), hashing, symlink probing and a
 * 5-point failure message builder. No real tenant, no real credentials.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Failure {
  what: string;
  why: string;
  expected: string;
  actual: string;
  guidance: string;
}

/** Throws a 5-point message (what, why, expected, actual, guidance) when !ok. */
export const assertThat = (ok: boolean, f: Failure): void => {
  if (ok) return;
  throw new Error(
    [
      `1. WHAT FAILED: ${f.what}`,
      `2. WHY: ${f.why}`,
      `3. EXPECTED: ${f.expected}`,
      `4. ACTUAL: ${f.actual}`,
      `5. GUIDANCE: ${f.guidance}`,
    ].join("\n"),
  );
};

export const sha256 = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

/** A fresh real (symlink-free) temp directory to use as ROOT. */
export const makeRoot = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "esc4-root-")));

export const removeDir = (dir: string): void => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

/** Tries to create a symlink; returns false when the OS refuses (e.g. no privilege). */
export const trySymlink = (
  target: string,
  linkPath: string,
  type: "file" | "dir",
): boolean => {
  try {
    fs.symlinkSync(target, linkPath, type === "dir" ? "junction" : "file");
    return true;
  } catch {
    return false;
  }
};

/** Symlink capability, probed synchronously at module load so tests can it.skip visibly. */
const probe = (type: "file" | "dir"): boolean => {
  const dir = makeRoot();
  try {
    const target = path.join(dir, "t");
    if (type === "file") fs.writeFileSync(target, "x");
    else fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      path.join(dir, "l"),
      type === "file" ? "file" : "junction",
    );
    return true;
  } catch {
    return false;
  } finally {
    removeDir(dir);
  }
};
export const CAN_FILE_SYMLINK = probe("file");
export const CAN_DIR_SYMLINK = probe("dir");

/** Hard-link capability, probed at module load. */
export const CAN_HARDLINK = ((): boolean => {
  const dir = makeRoot();
  try {
    fs.writeFileSync(path.join(dir, "t"), "x");
    fs.linkSync(path.join(dir, "t"), path.join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    removeDir(dir);
  }
})();

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; code?: string };

/** True when the failure carries the error code as `code` or inside its message. */
export const hasCode = (o: Outcome<unknown>, code: string): boolean =>
  !o.ok && (o.code === code || o.message.includes(code));

/**
 * Runs fn and normalises both failure styles the contract allows (a thrown
 * Error, or a returned object carrying a string `error`) into one outcome.
 */
export const attempt = async <T>(
  fn: () => T | Promise<T>,
): Promise<Outcome<T>> => {
  try {
    const value: any = await fn();
    if (
      value &&
      typeof value === "object" &&
      typeof value.error === "string" &&
      value.error !== ""
    ) {
      return {
        ok: false,
        message: value.error,
        code: typeof value.code === "string" ? value.code : undefined,
      };
    }
    return { ok: true, value };
  } catch (e: any) {
    return {
      ok: false,
      message: String(e?.message ?? e),
      code: typeof e?.code === "string" ? e.code : undefined,
    };
  }
};

export const describeOutcome = (o: Outcome<unknown>): string =>
  o.ok ? `succeeded with ${JSON.stringify(o.value)}` : `failed: ${o.message}`;

/** Runs a handler call, turning a thrown error into `{ error }`. */
export const callTool = async (
  h: { handleToolCall: (n: string, a: any) => Promise<any> },
  args: Record<string, unknown>,
): Promise<any> => {
  try {
    return await h.handleToolCall("manage_flow_nodes", args);
  } catch (e: any) {
    return { error: String(e?.message ?? e), thrown: true };
  }
};
