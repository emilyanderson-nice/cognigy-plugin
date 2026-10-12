import { describe, it, afterEach } from "@jest/globals";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { ProfileConfigError } from "../profiles/profiles.js";
import { removeProfile, upsertProfile } from "../profiles/profilesStore.js";
import { writeUserConfigFile } from "../userConfigFile.js";
import {
  cleanupTmp,
  freshDir,
  readJson,
  recorder,
  type Call,
} from "./helpers/configFixtures.js";
import { eq, ok, raises, show } from "./helpers/specAssert.js";

afterEach(cleanupTmp);

const posixIt = process.platform === "win32" ? it.skip : it;
const DEV = { apiBaseUrl: "https://api-dev.test", apiKey: "fake-key-dev" };
const SLOTS = [
  "config.json.bak",
  "config.json.bak.1",
  "config.json.bak.2",
  "config.json.bak.3",
  "config.json.bak.4",
  "config.json.bak.5",
];
const isDirGrant = (c: Call): boolean => c.args[3].endsWith(":(OI)(CI)F");

describe("H2: a corrupt file never destroys an existing backup", () => {
  it("fills .bak, .bak.1 ... .bak.5, then only .bak.5 rotates; every backup is restricted", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    const rec = recorder();
    const expected: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      const corrupt = `{ corrupt number ${i}`;
      writeFileSync(cfg, corrupt);
      const callsBefore = rec.calls.length;
      writeUserConfigFile({ K: "v" }, dir, {
        platform: "win32",
        run: rec.run,
      });
      const slot = SLOTS[Math.min(i, 5)];
      expected[slot] = corrupt;

      const actual: Record<string, string> = {};
      for (const s of SLOTS) {
        if (existsSync(join(dir, s)))
          actual[s] = readFileSync(join(dir, s), "utf8");
      }
      eq(
        actual,
        expected,
        `corrupt write #${i + 1}: backup slots`,
        "H2: the newest corruption is saved; slots 0-4 are never overwritten, only .bak.5 rotates",
        "Copy to the first free slot among .bak, .bak.1 ... .bak.5; when all are taken, replace .bak.5 only.",
      );
      ok(
        !existsSync(join(dir, "config.json.bak.6")),
        `corrupt write #${i + 1}: no slot beyond 5`,
        "H2: slots stop at .bak.5",
        "no config.json.bak.6",
        "config.json.bak.6 exists",
        "Never create more than six backup files.",
      );
      const restricted = rec.calls
        .slice(callsBefore)
        .some((c) => c.args[0] === join(dir, slot));
      ok(
        restricted,
        `corrupt write #${i + 1}: backup restricted`,
        "H2/H5: the backup is passed to restrictToOwner",
        `an icacls call targeting ${slot}`,
        show(rec.calls.slice(callsBefore).map((c) => c.args[0])),
        "Restrict every backup file to the owner.",
      );
      eq(
        readJson(cfg),
        { K: "v" },
        `corrupt write #${i + 1}: new file`,
        "D: the new file contains only values",
        "Write just the supplied values.",
      );
    }
  });

  it("a pre-existing good backup is untouched by a later corruption", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json.bak"), "GOOD-BACKUP-CONTENT");
    writeFileSync(join(dir, "config.json"), "{ broken");
    writeUserConfigFile({ K: "v" }, dir, {
      platform: "win32",
      run: recorder().run,
    });
    eq(
      [
        readFileSync(join(dir, "config.json.bak"), "utf8"),
        readFileSync(join(dir, "config.json.bak.1"), "utf8"),
      ],
      ["GOOD-BACKUP-CONTENT", "{ broken"],
      "writeUserConfigFile(existing .bak)",
      "H2: existing .bak preserved byte-for-byte, new copy in .bak.1",
      "Never overwrite a backup in slots .bak to .bak.4.",
    );
  });

  it("the store shares the rotation (two corrupt upserts give .bak and .bak.1)", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    const o = { path: cfg, platform: "win32", run: recorder().run } as never;
    writeFileSync(cfg, "first broken");
    upsertProfile("a", DEV, o);
    writeFileSync(cfg, "second broken");
    upsertProfile("b", DEV, o);
    eq(
      [
        readFileSync(join(dir, "config.json.bak"), "utf8"),
        readFileSync(join(dir, "config.json.bak.1"), "utf8"),
        readJson(cfg),
      ],
      ["first broken", "second broken", { profiles: { b: DEV } }],
      "upsertProfile(corrupt twice)",
      "H2: store backups use the same non-destructive rotation",
      "Keep both corrupt originals.",
    );
  });

  it("valid files never create backups (write and store)", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    const run = recorder().run;
    writeUserConfigFile({ K: "1" }, dir, { platform: "win32", run });
    writeUserConfigFile({ K: "2" }, dir, { platform: "win32", run });
    upsertProfile("a", DEV, { path: cfg, platform: "win32", run } as never);
    removeProfile("a", { path: cfg, platform: "win32", run } as never);
    eq(
      readdirSync(dir),
      ["config.json"],
      "valid file writes",
      "H2: only corrupt files are backed up",
      "Create no backup when the existing file is a valid JSON object.",
    );
  });

  posixIt("the backup file has mode 0600 on POSIX", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{ broken fake-key-xyz", {
      mode: 0o644,
    });
    writeUserConfigFile({ K: "v" }, dir, { platform: "linux" });
    eq(
      statSync(join(dir, "config.json.bak")).mode & 0o777,
      0o600,
      "backup file mode",
      "H5: the backup may hold secrets so it is owner-only",
      "Create or tighten the backup to rw for the owner only.",
    );
  });
});

describe("H3: read errors are not corruption", () => {
  const ops: [string, (dir: string, cfg: string) => unknown][] = [
    [
      "writeUserConfigFile",
      (dir) =>
        writeUserConfigFile({ K: "fake-key-aaaa" }, dir, {
          platform: "win32",
          run: recorder().run,
        }),
    ],
    [
      "upsertProfile",
      (_d, cfg) =>
        upsertProfile("dev", DEV, {
          path: cfg,
          platform: "win32",
          run: recorder().run,
        } as never),
    ],
    [
      "removeProfile",
      (_d, cfg) =>
        removeProfile("dev", {
          path: cfg,
          platform: "win32",
          run: recorder().run,
        } as never),
    ],
  ];

  it.each(ops)(
    "%s throws when config.json is a directory (EISDIR) and creates no backup",
    (name, op) => {
      const dir = freshDir();
      const cfg = join(dir, "config.json");
      mkdirSync(cfg);
      writeFileSync(join(cfg, "inner.txt"), "original");
      const err = raises(
        () => op(dir, cfg),
        Error,
        `${name}(config.json is a directory)`,
        "H3: an unreadable target is an error, not corruption",
        "Throw instead of treating a read failure as a corrupt file.",
      );
      ok(
        !(err instanceof ProfileConfigError) &&
          !err.message.includes(dir) &&
          !err.message.includes("fake-key"),
        `${name}(EISDIR) error`,
        "H3: plain Error without the path or secrets",
        "a non-ProfileConfigError message free of the directory path",
        show(err.message),
        "Report the failure without paths or key material.",
      );
      ok(
        readdirSync(dir).join() === "config.json" &&
          statSync(cfg).isDirectory() &&
          readFileSync(join(cfg, "inner.txt"), "utf8") === "original",
        `${name}(EISDIR) state`,
        "H3: nothing backed up, replaced or left behind",
        "only the original config.json directory",
        show(readdirSync(dir)),
        "Leave the target untouched and create no .bak, temp or lock files.",
      );
    },
  );
});

describe("H5: directory is restricted before any secret-bearing file exists", () => {
  it("missing directory: created, restricted first, with no files inside yet", () => {
    const dir = join(freshDir(), "newcfg");
    let snapshot: string[] | undefined;
    let existedAtFirstCall: boolean | undefined;
    const rec = recorder((n) => {
      if (n === 1) {
        existedAtFirstCall = existsSync(dir);
        snapshot = readdirSync(dir).filter((f) => !f.endsWith(".lock"));
      }
    });
    writeUserConfigFile({ K: "fake-key-aaaa" }, dir, {
      platform: "win32",
      run: rec.run,
    });
    ok(
      existedAtFirstCall === true &&
        snapshot?.length === 0 &&
        rec.calls[0].args[0] === dir &&
        isDirGrant(rec.calls[0]),
      "writeUserConfigFile(new dir): first restriction",
      "H5: mkdir, then restrict the dir, before any temp or backup file is created",
      "first icacls call targets the directory (dir grant) and the dir is still empty",
      show({ existedAtFirstCall, snapshot, first: rec.calls[0] }),
      "Create and restrict the directory before writing any file into it.",
    );
    ok(
      rec.calls.slice(1).every((c) => c.args[0] !== dir && !isDirGrant(c)) &&
        rec.calls.length >= 2,
      "writeUserConfigFile(new dir): file restriction",
      "H5: the dir restriction precedes, and is not repeated among, file restrictions",
      "all later calls are file grants",
      show(rec.calls.map((c) => c.args[0])),
      "Restrict the directory once, then the files.",
    );
  });

  it("corrupt existing file: dir restricted before the backup and temp files appear", () => {
    const dir = freshDir();
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, "{ broken");
    let snapshot: string[] | undefined;
    const rec = recorder((n) => {
      if (n === 1)
        snapshot = readdirSync(dir).filter((f) => !f.endsWith(".lock"));
    });
    upsertProfile("dev", DEV, {
      path: cfg,
      platform: "win32",
      run: rec.run,
    } as never);
    ok(
      rec.calls[0].args[0] === dir &&
        isDirGrant(rec.calls[0]) &&
        snapshot?.join() === "config.json",
      "upsertProfile(corrupt file): first restriction",
      "H5: only the original file exists when the dir is restricted",
      "dir restricted first; no backup or temp file yet",
      show({ snapshot, first: rec.calls[0] }),
      "Restrict the directory before creating backups or temporary files.",
    );
    const targets = rec.calls.map((c) => c.args[0]);
    ok(
      targets.includes(join(dir, "config.json.bak")) &&
        targets.includes(cfg) &&
        targets.indexOf(dir) < targets.indexOf(join(dir, "config.json.bak")),
      "upsertProfile(corrupt file): restriction targets",
      "H2/H5: backup and config are each restricted after the directory",
      "dir, then config.json.bak and config.json",
      show(targets),
      "Restrict the directory first and then every file that holds secrets.",
    );
  });
});
