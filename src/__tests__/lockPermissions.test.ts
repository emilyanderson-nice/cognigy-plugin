/**
 * Defect 1: acquireLock must never spin. Every loop iteration has to return,
 * throw or sleep (one immediate retry allowed after a stale lock was removed or
 * after the holder released the lock). Permission errors fail fast with a
 * secret-free message; stale-removal failures are contention up to the deadline.
 *
 * All file system access goes through the injected `fs` seam over an in-memory
 * lock model, a fake clock (advances only when `sleep` is called) and a runaway
 * sentinel (openSync throws "RUNAWAY LOOP" after 1000 calls) so a regression
 * fails instead of hanging jest. No real credentials folder is ever touched.
 */
import { afterEach, describe, it } from "@jest/globals";
import { chmodSync } from "fs";
import { basename, dirname, join } from "path";
import { acquireLock } from "../configFileIo.js";
import { writeUserConfigFile } from "../userConfigFile.js";
import { cleanupTmp, codeError, freshDir } from "./helpers/configFixtures.js";
import { eq, fail, ok } from "./helpers/specAssert.js";

afterEach(cleanupTmp);

const T0 = 1_700_000_000_000;
const SLEEP_STEP_MS = 25;
const RUNAWAY_LIMIT = 1000;
const TEST_TIMEOUT_MS = 15_000;

interface Scenario {
  timeoutMs: number;
  /** Age of a pre-existing lock file in ms (undefined = no lock file). */
  lockAgeMs?: number;
  /** Forced failure for the n-th (1-based) openSync call. */
  openFailure?: (n: number) => Error | undefined;
  /** Forced failure for the n-th (1-based) rmSync call. */
  rmFailure?: (n: number) => Error | undefined;
}

interface Outcome {
  error?: Error;
  returned: boolean;
  opens: number;
  sleeps: number;
  removals: number;
  elapsedMs: number;
  maxOpensBetweenSleeps: number;
  lockExists: boolean;
  dir: string;
  lockPath: string;
}

async function run(s: Scenario): Promise<Outcome> {
  const dir = freshDir();
  const lockPath = join(dir, "config.json.lock");
  let now = T0;
  let lock: { mtimeMs: number } | undefined =
    s.lockAgeMs === undefined ? undefined : { mtimeMs: T0 - s.lockAgeMs };
  let opens = 0;
  let sleeps = 0;
  let removals = 0;
  let sinceSleep = 0;
  let maxOpensBetweenSleeps = 0;

  const fs = {
    openSync: (): number => {
      opens++;
      sinceSleep++;
      maxOpensBetweenSleeps = Math.max(maxOpensBetweenSleeps, sinceSleep);
      if (opens > RUNAWAY_LIMIT) throw new Error("RUNAWAY LOOP");
      const forced = s.openFailure?.(opens);
      if (forced) throw forced;
      if (lock) throw codeError("EEXIST");
      lock = { mtimeMs: now };
      return 42;
    },
    closeSync: (): void => undefined,
    statSync: (_p: unknown, o?: { throwIfNoEntry?: boolean }): unknown => {
      if (!lock) {
        if (o?.throwIfNoEntry === false) return undefined;
        throw codeError("ENOENT");
      }
      return {
        mtimeMs: lock.mtimeMs,
        mtime: new Date(lock.mtimeMs),
        size: 0,
        isFile: () => true,
      };
    },
    rmSync: (): void => {
      removals++;
      const forced = s.rmFailure?.(removals);
      if (forced) throw forced;
      lock = undefined;
    },
  };

  const options = {
    timeoutMs: s.timeoutMs,
    now: () => now,
    sleep: (): void => {
      sleeps++;
      sinceSleep = 0;
      now += SLEEP_STEP_MS;
    },
    fs,
  };

  let error: Error | undefined;
  let returned = false;
  try {
    await (acquireLock as (p: string, o: unknown) => unknown)(
      lockPath,
      options,
    );
    returned = true;
  } catch (e) {
    error = e as Error;
  }
  return {
    error,
    returned,
    opens,
    sleeps,
    removals,
    elapsedMs: now - T0,
    maxOpensBetweenSleeps,
    lockExists: lock !== undefined,
    dir,
    lockPath,
  };
}

/** Shared spin guard: no runaway, and at most one immediate retry per sleep. */
function expectNoSpin(label: string, r: Outcome): void {
  ok(
    r.error?.message !== "RUNAWAY LOOP",
    label,
    "Defect 1b: every loop iteration must return, throw or sleep",
    `no more than ${RUNAWAY_LIMIT} lock attempts (finite loop)`,
    `runaway sentinel tripped: ${r.opens} openSync calls, ${r.sleeps} sleeps, fake time advanced ${r.elapsedMs} ms`,
    "Wait (sleep) before retrying, and honour the deadline, even when the lock cannot be created or inspected",
  );
  ok(
    r.maxOpensBetweenSleeps <= 2,
    label,
    "Defect 1b: at most ONE immediate retry, never two in a row without sleeping",
    "at most 2 lock-creation attempts between consecutive sleeps",
    `${r.maxOpensBetweenSleeps} attempts without a sleep in between`,
    "Pause between attempts; only retry at once after a removed stale lock or a released lock",
  );
}

function expectPlainError(label: string, r: Outcome, why: string): Error {
  if (!r.error) {
    fail(
      label,
      why,
      "an Error is thrown",
      `returned normally after ${r.opens} attempts`,
      "Throw instead of returning when the lock can never be taken",
    );
  }
  const err = r.error as Error;
  ok(
    Object.getPrototypeOf(err) === Error.prototype,
    label,
    why,
    "a plain Error (not a subclass)",
    `${err.constructor.name}: ${err.message}`,
    "Throw a plain Error with a safe message",
  );
  return err;
}

describe("Defect 1c: permission errors when creating the lock", () => {
  it.each(["EACCES", "EPERM"])(
    "%s on create with no lock file: 3 attempts with sleeps, then a permission message naming only the directory base name",
    async (code) => {
      const label = `acquireLock(open fails with ${code}, no lock file)`;
      const r = await run({
        timeoutMs: 5000,
        openFailure: () => codeError(code),
      });
      expectNoSpin(label, r);
      const err = expectPlainError(
        label,
        r,
        "Defect 1c: permission failure raises a plain Error",
      );
      eq(
        r.opens,
        3,
        label,
        "Defect 1c: exactly 3 attempts in total are made",
        "Retry twice (with sleeps) then give up",
      );
      ok(
        r.sleeps >= 2,
        label,
        "Defect 1c: retries are separated by sleeps",
        "at least 2 sleeps between the 3 attempts",
        `${r.sleeps} sleeps`,
        "Sleep between permission retries",
      );
      ok(
        r.elapsedMs < 5000,
        label,
        "Defect 1c: must not wait for the full timeout",
        "fail well before timeoutMs (5000 ms)",
        `fake time advanced ${r.elapsedMs} ms`,
        "Give up after the third failed attempt",
      );
      const m = err.message;
      ok(
        /permission/i.test(m) &&
          /lock/i.test(m) &&
          /credentials folder/i.test(m) &&
          m.includes(basename(r.dir)),
        label,
        "Defect 1c: message explains the lock file cannot be created because of a permission error in the credentials folder, naming the folder base name",
        `message with permission, lock, "credentials folder" and "${basename(r.dir)}"`,
        JSON.stringify(m),
        "Say what failed and where (folder base name only)",
      );
      ok(
        !m.includes(dirname(r.lockPath)) && !/another process/i.test(m),
        label,
        "Defect 1c: no full path, and it is not a contention message",
        "no full directory path and no 'another process' wording",
        JSON.stringify(m),
        "Do not leak the full path or blame another process",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["EACCES", 1],
    ["EPERM", 2],
  ] as const)(
    "transient %s (fails %i time(s) then succeeds) is tolerated",
    async (code, failures) => {
      const label = `acquireLock(${code} x${failures} then success)`;
      const r = await run({
        timeoutMs: 5000,
        openFailure: (n) => (n <= failures ? codeError(code) : undefined),
      });
      expectNoSpin(label, r);
      ok(
        r.returned && r.lockExists,
        label,
        "Defect 1c: up to 3 attempts tolerate transient antivirus/indexer errors",
        "lock acquired on the following attempt",
        r.error ? JSON.stringify(r.error.message) : "returned without lock",
        "Retry (with a sleep) before concluding the folder is not writable",
      );
      ok(
        r.sleeps >= failures,
        label,
        "Defect 1b/1c: each failed attempt is followed by a sleep",
        `at least ${failures} sleep(s)`,
        `${r.sleeps} sleeps`,
        "Sleep after every failed attempt",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "three permission failures followed by success still fails (only 3 attempts total)",
    async () => {
      const label = "acquireLock(EACCES x3 then success)";
      const r = await run({
        timeoutMs: 5000,
        openFailure: (n) => (n <= 3 ? codeError("EACCES") : undefined),
      });
      expectNoSpin(label, r);
      ok(
        !r.returned && r.opens === 3,
        label,
        "Defect 1c: the attempt budget is 3",
        "throws after exactly 3 attempts",
        `returned=${r.returned}, attempts=${r.opens}`,
        "Stop after the third permission failure",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "EBUSY keeps retrying until the deadline",
    async () => {
      const label = "acquireLock(open fails with EBUSY, no lock file)";
      const r = await run({
        timeoutMs: 500,
        openFailure: () => codeError("EBUSY"),
      });
      expectNoSpin(label, r);
      const err = expectPlainError(
        label,
        r,
        "Defect 1c: EBUSY ends in an error at the deadline",
      );
      ok(
        r.elapsedMs >= 500 && r.opens > 3,
        label,
        "Defect 1c: EBUSY is not treated as a permission failure; it retries until timeoutMs",
        "more than 3 attempts and fake time >= 500 ms",
        `${r.opens} attempts, fake time ${r.elapsedMs} ms`,
        "Keep sleeping and retrying until the deadline passes",
      );
      ok(
        !/credentials folder/i.test(err.message),
        label,
        "Defect 1c: EBUSY must not produce the permission message",
        "no 'credentials folder' permission wording",
        JSON.stringify(err.message),
        "Reserve the permission message for EACCES/EPERM",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Defect 1d: removing a stale lock fails", () => {
  const FAILURES: [string, () => Error][] = [
    ["EACCES", () => codeError("EACCES")],
    ["EPERM", () => codeError("EPERM")],
    ["EBUSY", () => codeError("EBUSY")],
    ["an error without a code", () => new Error("boom")],
  ];

  it.each(FAILURES)(
    "rmSync throws %s every time: contention until the deadline, then a stale-lock message",
    async (_label, make) => {
      const label = `acquireLock(stale lock, removal throws ${_label})`;
      const r = await run({
        timeoutMs: 500,
        lockAgeMs: 60_000,
        rmFailure: () => make(),
      });
      expectNoSpin(label, r);
      const err = expectPlainError(
        label,
        r,
        "Defect 1d: an unremovable stale lock ends in a plain Error",
      );
      ok(
        r.elapsedMs >= 500 && r.removals >= 2 && r.sleeps >= 2,
        label,
        "Defect 1d: a failed removal is contention (sleep, count toward the deadline)",
        "removal retried across sleeps until fake time >= 500 ms",
        `${r.removals} removals, ${r.sleeps} sleeps, fake time ${r.elapsedMs} ms`,
        "Sleep after a failed removal and try again until the deadline",
      );
      const m = err.message;
      ok(
        /stale/i.test(m) &&
          /could not be removed/i.test(m) &&
          m.includes("config.json.lock"),
        label,
        "Defect 1d: message says a stale lock file could not be removed and names the lock base name",
        'message with "stale", "could not be removed" and "config.json.lock"',
        JSON.stringify(m),
        "State that the stale lock could not be removed (permission or in use)",
      );
      ok(
        !m.includes(dirname(r.lockPath)) && !/another process/i.test(m),
        label,
        "Defect 1d: no full path and no claim of another process",
        "no full directory path and no 'another process' wording",
        JSON.stringify(m),
        "Name only the base name and do not blame another process",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a removal failure is followed by a sleep, and the lock is taken once removal works",
    async () => {
      const label = "acquireLock(stale lock, removal fails once then works)";
      const r = await run({
        timeoutMs: 5000,
        lockAgeMs: 60_000,
        rmFailure: (n) => (n === 1 ? codeError("EBUSY") : undefined),
      });
      expectNoSpin(label, r);
      ok(
        r.returned && r.lockExists && r.removals === 2 && r.sleeps >= 1,
        label,
        "Defect 1d: failed removal sleeps (no immediate retry), later removal succeeds",
        "acquired after 2 removal attempts with at least 1 sleep",
        `returned=${r.returned}, removals=${r.removals}, sleeps=${r.sleeps}`,
        "Sleep after a failed removal, then reclaim the stale lock",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Defect 1b: the lock vanishes or cannot be inspected", () => {
  it(
    "open says EEXIST but stat says ENOENT forever: sleeps and ends at the deadline",
    async () => {
      const label = "acquireLock(open EEXIST, stat ENOENT, persistent)";
      const r = await run({
        timeoutMs: 500,
        openFailure: () => codeError("EEXIST"),
      });
      expectNoSpin(label, r);
      expectPlainError(
        label,
        r,
        "Defect 1b: an inconsistent lock still ends in an error at the deadline",
      );
      ok(
        r.elapsedMs >= 500 && r.sleeps >= 10,
        label,
        "Defect 1b: the deadline is honoured while sleeping",
        "fake time >= 500 ms with at least 10 sleeps",
        `fake time ${r.elapsedMs} ms, ${r.sleeps} sleeps`,
        "Sleep between attempts and check the deadline each iteration",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "holder released between open and stat: one immediate retry acquires the lock",
    async () => {
      const label = "acquireLock(open EEXIST once, lock released)";
      const r = await run({
        timeoutMs: 5000,
        openFailure: (n) => (n === 1 ? codeError("EEXIST") : undefined),
      });
      expectNoSpin(label, r);
      ok(
        r.returned && r.lockExists,
        label,
        "Defect 1b: a released lock can be taken",
        "lock acquired",
        r.error ? JSON.stringify(r.error.message) : "no lock held",
        "Retry after observing the holder released the lock",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Defect 1e: existing contention behaviour is unchanged", () => {
  it(
    "a fresh foreign lock: waits, throws the contention message, never deletes the lock",
    async () => {
      const label = "acquireLock(fresh foreign lock)";
      const r = await run({ timeoutMs: 500, lockAgeMs: 0 });
      expectNoSpin(label, r);
      const err = expectPlainError(
        label,
        r,
        "Defect 1e: contention ends in a plain Error",
      );
      const m = err.message;
      ok(
        /another process/i.test(m) &&
          /retry/i.test(m) &&
          /stale/i.test(m) &&
          /30 seconds/i.test(m),
        label,
        "Defect 1e: message mentions another process, retry, stale and 30 seconds",
        "message matching /another process/, /retry/, /stale/ and /30 seconds/",
        JSON.stringify(m),
        "Keep the existing contention wording",
      );
      ok(
        r.lockExists && r.removals === 0 && r.elapsedMs >= 500,
        label,
        "Defect 1e: foreign lock is kept and the full timeout is waited",
        "lock still present, 0 removals, fake time >= 500 ms",
        `lockExists=${r.lockExists}, removals=${r.removals}, fake time ${r.elapsedMs} ms`,
        "Never delete a fresh lock held by someone else",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a stale lock (older than staleMs) is reclaimed",
    async () => {
      const label = "acquireLock(stale lock)";
      const r = await run({ timeoutMs: 5000, lockAgeMs: 60_000 });
      expectNoSpin(label, r);
      ok(
        r.returned && r.removals === 1 && r.lockExists,
        label,
        "Defect 1e: stale locks are reclaimed",
        "1 removal then lock acquired",
        `returned=${r.returned}, removals=${r.removals}, lockExists=${r.lockExists}`,
        "Remove the stale lock and take it",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

const rootOrWindows = process.platform === "win32" || process.getuid?.() === 0;
(rootOrWindows ? describe.skip : describe)(
  "Defect 1c (real POSIX file system)",
  () => {
    it(
      "read-only directory: writeUserConfigFile rejects quickly with the permission message",
      () => {
        const label = "writeUserConfigFile(read-only directory)";
        const dir = freshDir();
        chmodSync(dir, 0o500);
        const start = Date.now();
        let error: Error | undefined;
        try {
          writeUserConfigFile({ X: "1" }, dir, {
            platform: "linux",
            run: () => ({ status: 0 }),
            lock: { timeoutMs: 100 },
          } as never);
        } catch (e) {
          error = e as Error;
        } finally {
          chmodSync(dir, 0o700);
        }
        const elapsed = Date.now() - start;
        ok(
          error !== undefined,
          label,
          "Defect 1c: an unwritable credentials folder must fail",
          "an Error is thrown",
          "returned normally",
          "Fail when the lock cannot be created",
        );
        ok(
          elapsed < 2000,
          label,
          "Defect 1c: no spinning",
          "failure within 2000 ms",
          `${elapsed} ms`,
          "Give up after a few attempts",
        );
        const m = (error as Error).message;
        ok(
          /permission/i.test(m) &&
            /credentials folder/i.test(m) &&
            m.includes(basename(dir)) &&
            !m.includes(dirname(dir)),
          label,
          "Defect 1c: permission message names only the folder base name",
          `message with permission, "credentials folder" and "${basename(dir)}" but no parent path`,
          JSON.stringify(m),
          "Explain the permission problem without the full path",
        );
      },
      TEST_TIMEOUT_MS,
    );
  },
);
