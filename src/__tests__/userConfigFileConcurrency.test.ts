import { describe, it, afterEach } from "@jest/globals";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { ProfileConfigError } from "../profiles/profiles.js";
import {
  removeProfile,
  setDefaultProfile,
  upsertProfile,
} from "../profiles/profilesStore.js";
import { writeUserConfigFile } from "../userConfigFile.js";
import {
  cleanupTmp,
  codeError,
  freshDir,
  readJson,
  recorder,
} from "./helpers/configFixtures.js";
import { eq, ok, raises, show } from "./helpers/specAssert.js";

afterEach(cleanupTmp);

const DEV = { apiBaseUrl: "https://api-dev.test", apiKey: "fake-key-dev" };
const SEED = { K: "v", defaultProfile: "dev", profiles: { dev: DEV } };

/** Options object accepted by every writer (cast: new option fields H1/H4). */
function opts(extra: Record<string, unknown> = {}, path?: string): never {
  const { run } = recorder();
  return {
    platform: "win32",
    run,
    ...(path ? { path } : {}),
    ...extra,
  } as never;
}

type Writer = [
  string,
  (dir: string, extra: Record<string, unknown>) => unknown,
];
const WRITERS: Writer[] = [
  [
    "writeUserConfigFile",
    (dir, extra) => writeUserConfigFile({ K: "x" }, dir, opts(extra)),
  ],
  [
    "upsertProfile",
    (dir, extra) =>
      upsertProfile("new", DEV, opts(extra, join(dir, "config.json"))),
  ],
  [
    "removeProfile",
    (dir, extra) => removeProfile("dev", opts(extra, join(dir, "config.json"))),
  ],
  [
    "setDefaultProfile",
    (dir, extra) =>
      setDefaultProfile("dev", opts(extra, join(dir, "config.json"))),
  ],
];

function seeded(): { dir: string; cfg: string; lock: string } {
  const dir = freshDir();
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify(SEED));
  return { dir, cfg, lock: join(dir, "config.json.lock") };
}

describe("H1: lock file serialises writers", () => {
  it.each(WRITERS)(
    "%s times out on a fresh foreign lock, leaves config and the foreign lock alone",
    (name, write) => {
      const { dir, cfg, lock } = seeded();
      writeFileSync(lock, "foreign");
      const before = readFileSync(cfg);
      const err = raises(
        () => write(dir, { lock: { timeoutMs: 50 } }),
        Error,
        `${name}(fresh foreign lock)`,
        "H1: a held lock must block the writer until timeout",
        "Wait for the lock, then give up with an exception rather than overwriting.",
      );
      ok(
        Object.getPrototypeOf(err) === Error.prototype &&
          /another process/i.test(err.message) &&
          /retry/i.test(err.message) &&
          /stale/i.test(err.message) &&
          /30 seconds/i.test(err.message) &&
          !err.message.includes(dir) &&
          !err.message.includes("fake-key") &&
          !(err instanceof ProfileConfigError),
        `${name}(fresh foreign lock) error`,
        "H1: plain Error saying another process is updating the file, to retry, and that a stale lock clears itself after 30 seconds; no path or secret",
        "plain Error mentioning 'another process', 'retry' and a stale lock clearing after 30 seconds, without the directory path",
        show(err.message),
        "Tell the user another process is updating the credentials file and to retry; mention that a stale lock clears itself after 30 seconds; reveal no paths or secrets.",
      );
      ok(
        readFileSync(cfg).equals(before) &&
          readFileSync(lock, "utf8") === "foreign",
        `${name}(fresh foreign lock) state`,
        "H1: config untouched and the foreign lock NOT deleted",
        "identical config bytes, lock content 'foreign'",
        show(readdirSync(dir)),
        "Never delete a lock you did not create and never write without holding it.",
      );
    },
  );

  it.each(WRITERS)(
    "%s removes a stale lock (older than the default 30000 ms) and succeeds",
    (name, write) => {
      const { dir, lock } = seeded();
      writeFileSync(lock, "dead process");
      const old = (Date.now() - 120_000) / 1000;
      utimesSync(lock, old, old);
      write(dir, {});
      eq(
        readdirSync(dir),
        ["config.json"],
        `${name}(stale lock)`,
        "H1: stale lock is taken over and released; no lock remains",
        "Treat a lock older than 30 s as abandoned, retake it, and delete it when done.",
      );
    },
  );

  it("honours a custom staleMs: a 2 s old lock is stale when staleMs is 1000", () => {
    const { dir, lock } = seeded();
    writeFileSync(lock, "x");
    const old = (Date.now() - 2000) / 1000;
    utimesSync(lock, old, old);
    writeUserConfigFile({ K: "x" }, dir, opts({ lock: { staleMs: 1000 } }));
    eq(
      readdirSync(dir),
      ["config.json"],
      "writeUserConfigFile(custom staleMs)",
      "H1: staleMs is injectable",
      "Compare lock age against options.lock.staleMs.",
    );
  });

  it("a 2 s old lock is NOT stale under the default and blocks", () => {
    const { dir, lock } = seeded();
    writeFileSync(lock, "x");
    const old = (Date.now() - 2000) / 1000;
    utimesSync(lock, old, old);
    raises(
      () =>
        writeUserConfigFile({ K: "x" }, dir, opts({ lock: { timeoutMs: 50 } })),
      Error,
      "writeUserConfigFile(young lock)",
      "H1: default staleMs is 30000",
      "Do not steal a lock younger than 30 s.",
    );
  });

  it("holds the lock for the whole cycle (present at rename time) and removes it after", () => {
    const { dir, lock } = seeded();
    let lockAtRename: boolean | undefined;
    const renameSpy = ((from: string, to: string) => {
      lockAtRename = existsSync(lock);
      renameSync(from, to);
    }) as never;
    writeUserConfigFile(
      { K: "x" },
      dir,
      opts({ fs: { renameSync: renameSpy } }),
    );
    eq(
      [lockAtRename, readdirSync(dir)],
      [true, ["config.json"]],
      "writeUserConfigFile(lock lifetime)",
      "H1: config.json.lock exists while the new file is moved into place and is gone afterwards",
      "Create the lock exclusively before reading and release it only after the rename.",
    );
  });

  it("releases the lock when the mutation throws (setDefaultProfile unknown name)", () => {
    const { dir } = seeded();
    raises(
      () => setDefaultProfile("ghost", opts({}, join(dir, "config.json"))),
      ProfileConfigError,
      "setDefaultProfile(unknown)",
      "H1: lock released in finally when the mutation throws",
      "Always release the lock, even on failure.",
    );
    eq(
      readdirSync(dir),
      ["config.json"],
      "setDefaultProfile(unknown) listing",
      "H1: no .lock remains after a failed call",
      "Remove the lock file on every exit path.",
    );
  });

  it("releases the lock when the rename throws", () => {
    const { dir } = seeded();
    const failing = (() => {
      throw codeError("EINVAL");
    }) as never;
    raises(
      () =>
        writeUserConfigFile(
          { K: "x" },
          dir,
          opts({ fs: { renameSync: failing } }),
        ),
      Error,
      "writeUserConfigFile(rename throws)",
      "H1: rename failure surfaces",
      "Throw when the file cannot be moved into place.",
    );
    eq(
      readdirSync(dir),
      ["config.json"],
      "writeUserConfigFile(rename throws) listing",
      "H1: neither lock nor temp file remain",
      "Release the lock and delete the temp file on failure.",
    );
  });

  it("40 sequential upserts all survive and leave no lock or temp files", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    const names: string[] = [];
    for (let i = 0; i < 40; i++) {
      names.push(`p${i}`);
      upsertProfile(
        `p${i}`,
        { ...DEV, apiKey: `fake-key-${i}` },
        opts({}, cfg),
      );
    }
    const profiles = (readJson(cfg) as { profiles: Record<string, unknown> })
      .profiles;
    eq(
      Object.keys(profiles).sort(),
      [...names].sort(),
      "40 sequential upsertProfile calls",
      "H1: no lost updates",
      "Every upserted profile is present in the final file.",
    );
    eq(
      readdirSync(dir),
      ["config.json"],
      "40 sequential upsertProfile calls (listing)",
      "H1: no .lock/.tmp files remain",
      "Release the lock and temp file after every call.",
    );
  });
});

describe("H4: rename retries on transient errors", () => {
  function flakyRename(
    failures: number,
    code: string,
  ): {
    fn: never;
    count: () => number;
  } {
    let n = 0;
    const fn = ((from: string, to: string) => {
      n++;
      if (n <= failures) throw codeError(code);
      renameSync(from, to);
    }) as never;
    return { fn, count: () => n };
  }
  const sleeps: number[] = [];
  const extra = (fn: never): Record<string, unknown> => {
    const sleep = (ms: number): void => {
      sleeps.push(ms);
    };
    return { fs: { renameSync: fn }, sleep, lock: { sleep } };
  };

  it.each([["EPERM"], ["EBUSY"], ["EACCES"]])(
    "%s three times then success: 4 attempts, write succeeds",
    (code) => {
      const { dir, cfg } = seeded();
      const flaky = flakyRename(3, code);
      writeUserConfigFile({ K: "new" }, dir, opts(extra(flaky.fn)));
      eq(
        [flaky.count(), readJson(cfg), readdirSync(dir)],
        [
          4,
          { K: "new", defaultProfile: "dev", profiles: { dev: DEV } },
          ["config.json"],
        ],
        `rename retry (${code} x3)`,
        "H4: transient errors are retried; exactly 4 rename calls",
        "Retry the rename up to 5 attempts for transient EPERM/EBUSY/EACCES.",
      );
    },
  );

  it.each([[5], [6]])(
    "transient failure on all attempts (failing %i times): throws after exactly 5 attempts, temp cleaned, original intact",
    (failures) => {
      const { dir, cfg } = seeded();
      const before = readFileSync(cfg);
      const flaky = flakyRename(failures, "EPERM");
      raises(
        () => writeUserConfigFile({ K: "new" }, dir, opts(extra(flaky.fn))),
        Error,
        `rename retry (EPERM x${failures})`,
        "H4: give up after 5 attempts",
        "Throw once 5 attempts have failed.",
      );
      ok(
        flaky.count() === 5 &&
          readFileSync(cfg).equals(before) &&
          readdirSync(dir).join() === "config.json",
        `rename retry (EPERM x${failures}) state`,
        "H4: exactly 5 attempts, original untouched, temp and lock removed",
        "5 attempts; only the original config.json remains",
        show({ attempts: flaky.count(), files: readdirSync(dir) }),
        "Cap retries at 5 and clean up after the final failure.",
      );
    },
  );

  it.each([["ENOENT"], ["EINVAL"]])(
    "non-transient %s fails immediately after one attempt",
    (code) => {
      const { dir } = seeded();
      const flaky = flakyRename(10, code);
      raises(
        () => writeUserConfigFile({ K: "new" }, dir, opts(extra(flaky.fn))),
        Error,
        `rename (${code})`,
        "H4: only EPERM/EBUSY/EACCES are retried",
        "Fail fast for non-transient error codes.",
      );
      ok(
        flaky.count() === 1 && readdirSync(dir).join() === "config.json",
        `rename (${code}) state`,
        "H4: one attempt, temp file removed",
        "1 attempt; only config.json remains",
        show({ attempts: flaky.count(), files: readdirSync(dir) }),
        "Do not retry non-transient errors; still clean up.",
      );
    },
  );

  it("upsertProfile retries the rename too (EBUSY x3 then success)", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    const flaky = flakyRename(3, "EBUSY");
    upsertProfile("dev", DEV, opts(extra(flaky.fn), cfg));
    eq(
      [flaky.count(), readJson(cfg)],
      [4, { profiles: { dev: DEV } }],
      "upsertProfile(rename retry)",
      "H4: the store shares the retrying atomic write",
      "Retry transient rename failures for every writer.",
    );
  });
});
