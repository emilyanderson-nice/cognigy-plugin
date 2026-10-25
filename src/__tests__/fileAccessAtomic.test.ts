import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { readTextFile, writeTextFile } from "../utils/fileAccess.js";
import {
  CAN_HARDLINK,
  assertThat,
  attempt,
  describeOutcome,
  makeRoot,
  removeDir,
  sha256,
} from "./helpers/fileTestKit.js";

// The CommonJS fs object: spying on it plus syncBuiltinESMExports() also
// redirects `import * as fs from "node:fs"` users in the module under test.
const fsx: any = createRequire(path.join(process.cwd(), "x.js"))("node:fs");

let root: string;
let outside: string;
const spies: Array<{ mockRestore: () => void }> = [];
let hits = 0;

const boom = (): Error =>
  Object.assign(new Error("EIO injected failure"), { code: "EIO" });

/** True for calls that target our temp ROOT (never stdout/stderr or other paths). */
const aimedAtRoot = (target: unknown): boolean =>
  typeof target === "number"
    ? target > 2
    : typeof target === "string" && path.resolve(target).startsWith(root);

const inject = (
  names: string[],
  onlyWhen: (target: unknown) => boolean = aimedAtRoot,
): void => {
  for (const name of names) {
    const original = fsx[name].bind(fsx);
    spies.push(
      jest.spyOn(fsx, name).mockImplementation(((...args: any[]) => {
        if (onlyWhen(args[0])) {
          hits++;
          throw boom();
        }
        return original(...args);
      }) as any),
    );
  }
  syncBuiltinESMExports();
};

const injectAsync = (names: string[]): void => {
  for (const name of names) {
    const original = fsx.promises[name].bind(fsx.promises);
    spies.push(
      jest.spyOn(fsx.promises, name).mockImplementation((async (
        ...args: any[]
      ) => {
        if (aimedAtRoot(args[0])) {
          hits++;
          throw boom();
        }
        return original(...args);
      }) as any),
    );
  }
};

const injectCallback = (names: string[]): void => {
  for (const name of names) {
    const original = fsx[name].bind(fsx);
    spies.push(
      jest.spyOn(fsx, name).mockImplementation(((...args: any[]) => {
        if (
          aimedAtRoot(args[0]) &&
          typeof args[args.length - 1] === "function"
        ) {
          hits++;
          args[args.length - 1](boom());
          return undefined;
        }
        return original(...args);
      }) as any),
    );
  }
  syncBuiltinESMExports();
};

const restoreAll = (): void => {
  while (spies.length) spies.pop()!.mockRestore();
  syncBuiltinESMExports();
  hits = 0;
};

beforeAll(() => {
  root = makeRoot();
  outside = makeRoot();
});
afterAll(() => {
  removeDir(root);
  removeDir(outside);
});
beforeEach(() => {
  hits = 0;
  for (const f of fs.readdirSync(root)) removeDir(path.join(root, f));
});
afterEach(restoreAll);

const listing = (): string[] => fs.readdirSync(root).sort();

describe("fileAccess atomic write (S4/S5)", () => {
  it("a rename failure on overwrite leaves the old target intact and no temp file", async () => {
    fs.writeFileSync(path.join(root, "t.txt"), "ORIGINAL");
    inject(["renameSync"]);
    injectAsync(["rename"]);
    injectCallback(["rename"]);
    const out = await attempt(() =>
      writeTextFile("t.txt", "NEW-CONTENT", root, { overwrite: true }),
    );
    restoreAll();
    assertThat(!out.ok, {
      what: "overwrite when the final rename fails",
      why: "an overwrite is temp file + rename; a rename failure must surface as an error",
      expected: "a rejection (the injected failure was hit)",
      actual: describeOutcome(out),
      guidance:
        "write to a unique temp file in the same directory, then rename over the target",
    });
    expect(fs.readFileSync(path.join(root, "t.txt"), "utf8")).toBe("ORIGINAL");
    expect(listing()).toEqual(["t.txt"]);
    if (!out.ok) expect(out.message).not.toContain("NEW-CONTENT");
  });

  it("a mid-write failure on overwrite leaves the old target intact and no temp file", async () => {
    fs.writeFileSync(path.join(root, "t.txt"), "ORIGINAL");
    inject(["writeSync", "writeFileSync", "fsyncSync"]);
    const out = await attempt(() =>
      writeTextFile("t.txt", "NEW-CONTENT", root, { overwrite: true }),
    );
    const hit = hits;
    restoreAll();
    assertThat(!out.ok && hit > 0, {
      what: "overwrite when the temp-file write/fsync fails",
      why: "a failed write must not truncate or replace the target",
      expected: "a rejection after the injected write/fsync failure was hit",
      actual: `hits=${hit}; ${describeOutcome(out)}`,
      guidance:
        "write via fs.writeSync/writeFileSync/fsyncSync on the temp file (or adjust the injection)",
    });
    expect(fs.readFileSync(path.join(root, "t.txt"), "utf8")).toBe("ORIGINAL");
    expect(listing()).toEqual(["t.txt"]);
  });

  it("a mid-write failure creating a new file leaves no target and no temp file", async () => {
    inject(["writeSync", "writeFileSync", "fsyncSync"]);
    const out = await attempt(() =>
      writeTextFile("new.txt", "NEW-CONTENT", root),
    );
    const hit = hits;
    restoreAll();
    assertThat(!out.ok && hit > 0, {
      what: "exclusive create when the temp-file write fails",
      why: "no partial or truncated target may remain",
      expected: "a rejection and an empty directory",
      actual: `hits=${hit}; ${describeOutcome(out)}; listing=${JSON.stringify(listing())}`,
      guidance: "unlink the temp file in a finally/catch on any failure",
    });
    expect(listing()).toEqual([]);
  });

  it("overwrite replaces the content, returns the new bytes and hash and leaves no temp file", async () => {
    fs.writeFileSync(path.join(root, "t.txt"), "ORIGINAL LONGER CONTENT");
    const out = await attempt(() =>
      writeTextFile("t.txt", "NEW", root, { overwrite: true }),
    );
    expect(out).toEqual({
      ok: true,
      value: { path: "t.txt", bytes: 3, sha256: sha256("NEW") },
    });
    expect(fs.readFileSync(path.join(root, "t.txt"), "utf8")).toBe("NEW");
    expect(listing()).toEqual(["t.txt"]);
  });

  it("exclusive create still refuses an existing file and leaves no temp file", async () => {
    fs.writeFileSync(path.join(root, "t.txt"), "ORIGINAL");
    const out = await attempt(() => writeTextFile("t.txt", "NEW", root));
    expect(out.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, "t.txt"), "utf8")).toBe("ORIGINAL");
    expect(listing()).toEqual(["t.txt"]);
  });

  it("a successful new write leaves only the target (no temp file)", async () => {
    const out = await attempt(() => writeTextFile("only.txt", "X", root));
    expect(out.ok).toBe(true);
    expect(listing()).toEqual(["only.txt"]);
  });

  const itHard = CAN_HARDLINK ? it : it.skip;
  itHard(
    "overwrite replaces the directory entry: a hard link to an outside file is never written through",
    async () => {
      const outsideFile = path.join(outside, "linked.txt");
      fs.writeFileSync(outsideFile, "OUTSIDE-ORIGINAL");
      fs.linkSync(outsideFile, path.join(root, "hl.txt"));
      const out = await attempt(() =>
        writeTextFile("hl.txt", "REPLACED", root, { overwrite: true }),
      );
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("OUTSIDE-ORIGINAL");
      expect(fs.readFileSync(path.join(root, "hl.txt"), "utf8")).toBe(
        "REPLACED",
      );
      expect(listing()).toEqual(["hl.txt"]);
    },
  );

  itHard(
    "a hard-linked target is not clobbered without overwrite either",
    async () => {
      const outsideFile = path.join(outside, "linked2.txt");
      fs.writeFileSync(outsideFile, "OUTSIDE-ORIGINAL");
      fs.linkSync(outsideFile, path.join(root, "hl2.txt"));
      const out = await attempt(() => writeTextFile("hl2.txt", "X", root));
      expect(out.ok).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("OUTSIDE-ORIGINAL");
    },
  );

  it("read recheck: a directory is reported as not a regular file and nothing is returned", async () => {
    fs.mkdirSync(path.join(root, "adir"));
    const out = await attempt(() => readTextFile("adir", root));
    expect(out.ok).toBe(false);
  });
});
