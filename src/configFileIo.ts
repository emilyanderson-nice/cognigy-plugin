/**
 * Low-level, secret-safe file helpers behind the user config file: owner-only
 * permissions (chmod, or icacls by SID on Windows), an exclusive lock file,
 * rotating backups and an atomic write with a bounded rename retry.
 *
 * No error or warning built here ever quotes file contents, runner output or
 * a full path: only base names and OS error codes.
 */
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { userInfo } from "os";
import { basename, dirname, join } from "path";

export type CommandRunner = (
  command: string,
  args: string[],
) => { status: number | null; stderr?: string; stdout?: string };

export interface LockOptions {
  /** How long to wait for the lock before giving up (default 5000 ms). */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned (default 30000 ms). */
  staleMs?: number;
  sleep?: (ms: number) => void;
  now?: () => number;
}

export interface PermissionOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

/** Everything a writer of the config file may inject (for tests). */
export interface WriteOptions extends PermissionOptions {
  lock?: LockOptions;
  fs?: { renameSync?: typeof renameSync };
  sleep?: (ms: number) => void;
}

export interface RestrictResult {
  ok: boolean;
  method: "chmod" | "icacls";
  warning?: string;
}

/** Failure that names the step and OS error code, never file contents. */
export function ioError(step: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new Error(`Could not ${step}${code ? ` (${code})` : ""}.`);
}

const errCode = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | undefined)?.code;

/** Synchronous pause (the config writers are synchronous by design). */
export function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultRunner(command: string, args: string[]) {
  const r = spawnSync(command, args, {
    shell: false,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (r.error) throw r.error;
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

/** `*S-1-5-...` for the current process token, or undefined when unavailable. */
function currentSid(run: CommandRunner): string | undefined {
  try {
    const out = run("whoami", ["/user", "/fo", "csv", "/nh"]);
    if (out.status !== 0) return undefined;
    const m = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec((out.stdout ?? "").trim());
    return m ? `*${m[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function fallbackWindowsUser(): string {
  const { USERDOMAIN, USERNAME } = process.env;
  return USERDOMAIN && USERNAME
    ? `${USERDOMAIN}\\${USERNAME}`
    : userInfo().username;
}

/**
 * Make `target` accessible to the current user only. Windows ignores chmod, so
 * it uses icacls (args as an array, never a shell string) and grants by SID;
 * elsewhere 0600/0700. Never throws: failure is `{ ok: false, warning }`.
 */
export function restrictToOwner(
  target: string,
  kind: "file" | "dir",
  options: PermissionOptions & { user?: string } = {},
): RestrictResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      chmodSync(target, kind === "dir" ? 0o700 : 0o600);
      return { ok: true, method: "chmod" };
    } catch {
      return {
        ok: false,
        method: "chmod",
        warning: `could not restrict permissions on ${basename(target)}`,
      };
    }
  }
  const run = options.run ?? defaultRunner;
  try {
    const user = options.user ?? currentSid(run) ?? fallbackWindowsUser();
    const grant = kind === "dir" ? `${user}:(OI)(CI)F` : `${user}:(F)`;
    const result = run("icacls", [target, "/inheritance:r", "/grant:r", grant]);
    if (result.status === 0) return { ok: true, method: "icacls" };
    return {
      ok: false,
      method: "icacls",
      warning: `icacls exited with status ${result.status} for ${basename(target)}`,
    };
  } catch {
    return {
      ok: false,
      method: "icacls",
      warning: `icacls could not run for ${basename(target)}`,
    };
  }
}

/**
 * Takes `<file>.lock` exclusively (flag wx), polling until the timeout and
 * reclaiming a lock older than `staleMs`. Returns the release function.
 */
export function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const started = now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return () => rmSync(lockPath, { force: true });
    } catch (err) {
      if (
        !["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(errCode(err) ?? "")
      ) {
        throw ioError(`lock ${basename(dirname(lockPath))}`, err);
      }
    }
    try {
      if (now() - statSync(lockPath).mtimeMs > staleMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      continue; // The holder released it between our attempts.
    }
    if (now() - started >= timeoutMs) {
      throw new Error(
        `Another process is updating the credentials file; please retry in a moment. A stale lock clears itself after ${Math.round(staleMs / 1000)} seconds.`,
      );
    }
    sleep(25);
  }
}

const MAX_BACKUP_INDEX = 5;

/**
 * Saves the current bytes of `file` without ever overwriting a good backup:
 * first free slot of `.bak`, `.bak.1` ... `.bak.5`; when all are taken the
 * newest copy replaces `.bak.5`. Slots are created owner-only, then restricted.
 */
export function backupRotating(
  file: string,
  options: PermissionOptions,
): RestrictResult {
  const bytes = readFileSync(file);
  const slot = (i: number) => (i === 0 ? `${file}.bak` : `${file}.bak.${i}`);
  let target = slot(MAX_BACKUP_INDEX);
  for (let i = 0; i < MAX_BACKUP_INDEX; i++) {
    try {
      writeFileSync(slot(i), bytes, { mode: 0o600, flag: "wx" });
      target = slot(i);
      return restrictToOwner(target, "file", options);
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw ioError("write a backup", err);
    }
  }
  try {
    writeFileSync(target, bytes, { mode: 0o600 });
  } catch (err) {
    throw ioError("write a backup", err);
  }
  return restrictToOwner(target, "file", options);
}

const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

/** Temp file in the same directory, then rename (bounded retry on Windows locks). */
export function atomicWrite(
  file: string,
  text: string,
  options: WriteOptions = {},
): void {
  const tmp = join(
    dirname(file),
    `.config.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const rename = options.fs?.renameSync ?? renameSync;
  const sleep = options.sleep ?? options.lock?.sleep ?? defaultSleep;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    for (let attempt = 1; ; attempt++) {
      try {
        rename(tmp, file);
        return;
      } catch (err) {
        if (
          !TRANSIENT_RENAME.has(errCode(err) ?? "") ||
          attempt >= RENAME_ATTEMPTS
        ) {
          throw err;
        }
        sleep(20 * attempt);
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw ioError(`write ${basename(file)}`, err);
  }
}
