import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  it,
  expect,
} from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readTextFile,
  resolveInRoot,
  writeTextFile,
} from "../utils/fileAccess.js";
import {
  assertThat,
  attempt,
  describeOutcome,
  hasCode,
  makeRoot,
  removeDir,
} from "./helpers/fileTestKit.js";

let root: string;
beforeAll(() => {
  root = makeRoot();
});
afterAll(() => removeDir(root));

/** Creates the file (and parents) under ROOT so only the deny rule can reject it. */
const seed = (rel: string, text = "seed"): void => {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};

// [category, path relative to ROOT]
const DENIED: Array<[string, string]> = [
  ["segment .git", ".git/config"],
  ["segment .git (upper case)", ".GIT/config"],
  ["segment .claude", ".claude/settings.json"],
  ["segment .cognigy-plugin", ".cognigy-plugin/config.json"],
  ["segment .vscode", ".vscode/settings.json"],
  ["segment .husky", ".husky/pre-commit"],
  ["segment .github", ".github/workflows/ci.yml"],
  ["segment .ssh", ".ssh/config"],
  ["segment .gnupg", ".gnupg/pubring.kbx"],
  ["segment .aws", ".aws/credentials.txt"],
  ["segment node_modules", "node_modules/x/index.js"],
  ["segment node_modules (mixed case)", "Node_Modules/x.txt"],
  ["nested denied segment", "a/b/.git/HEAD"],
  ["basename .env", ".env"],
  ["basename .env.local", ".env.local"],
  ["nested .env.local", "a/.env.local"],
  ["basename .ENV (upper case)", ".ENV"],
  ["basename .npmrc", ".npmrc"],
  ["basename .netrc", ".netrc"],
  ["basename package.json", "package.json"],
  ["basename Package.JSON (mixed case)", "Package.JSON"],
  ["basename package-lock.json", "package-lock.json"],
  ["basename .bashrc", ".bashrc"],
  ["basename .zshrc", ".zshrc"],
  ["basename .profile", ".profile"],
  ["basename .bash_profile", ".bash_profile"],
  ["suffix .pem", "certs/server.pem"],
  ["suffix .PEM (upper case)", "certs/SERVER.PEM"],
  ["suffix .key", "tls/private.key"],
  ["prefix id_rsa", "keys/id_rsa"],
  ["prefix id_rsa.pub", "keys/id_rsa.pub"],
  ["prefix id_ed25519", "keys/id_ed25519"],
  ["prefix credentials", "credentials"],
  ["prefix credentials.json", "cfg/credentials.json"],
  ["prefix Credentials.yml (mixed case)", "cfg/Credentials.yml"],
];

describe("fileAccess deny list (S1)", () => {
  it.each(DENIED)("read is denied for %s", async (_label, rel) => {
    seed(rel);
    const out = await attempt(() => readTextFile(rel, root));
    assertThat(!out.ok && hasCode(out, "denied_path"), {
      what: `readTextFile(${rel})`,
      why: "sensitive files are unreadable even inside ROOT (error code denied_path)",
      expected: "a rejection with code denied_path",
      actual: describeOutcome(out),
      guidance: "check every segment of the resolved path in resolveInRoot",
    });
    if (!out.ok) expect(out.message).not.toContain("seed");
  });

  it.each(DENIED)(
    "write is denied for %s and the file is untouched",
    async (_label, rel) => {
      seed(rel, "ORIGINAL");
      const out = await attempt(() =>
        writeTextFile(rel, "CHANGED", root, { overwrite: true }),
      );
      assertThat(!out.ok && hasCode(out, "denied_path"), {
        what: `writeTextFile(${rel}, overwrite)`,
        why: "sensitive files are unwritable even inside ROOT (error code denied_path)",
        expected: "a rejection with code denied_path",
        actual: describeOutcome(out),
        guidance: "deny before any file system write",
      });
      expect(fs.readFileSync(path.join(root, ...rel.split("/")), "utf8")).toBe(
        "ORIGINAL",
      );
    },
  );

  it.each(DENIED)("resolveInRoot rejects %s", async (_label, rel) => {
    const out = await attempt(() => resolveInRoot(rel, root));
    expect(out.ok).toBe(false);
    expect(hasCode(out, "denied_path")).toBe(true);
  });

  it("denies creating a new denied file and does not create it", async () => {
    const out = await attempt(() => writeTextFile(".env.fresh", "K=V", root));
    expect(hasCode(out, "denied_path")).toBe(true);
    expect(fs.existsSync(path.join(root, ".env.fresh"))).toBe(false);
  });

  it("denies back-slash spellings too", async () => {
    seed(".git/config");
    const out = await attempt(() => readTextFile(".git\\config", root));
    expect(hasCode(out, "denied_path")).toBe(true);
  });

  it("denies a denied segment reached through an inner '..' (resolved path is what counts)", async () => {
    seed(".git/config");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const out = await attempt(() => readTextFile("src/../.git/config", root));
    expect(hasCode(out, "denied_path")).toBe(true);
  });

  it.each([
    "notes.txt",
    "src/code.ts",
    "..foo.txt",
    "docs/environment.md",
    "monkey.txt",
    "keyboard.txt",
    "my.env.txt",
    "credit.txt",
    "gitignore.txt",
    "a/b/c/readme.md",
  ])("allows %s for write then read", async (rel) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    const w = await attempt(() => writeTextFile(rel, "fine", root));
    assertThat(w.ok, {
      what: `writeTextFile(${rel})`,
      why: "only the listed names are denied",
      expected: "success",
      actual: describeOutcome(w),
      guidance: "match whole segments / basenames and the listed globs only",
    });
    expect(await attempt(() => readTextFile(rel, root))).toEqual({
      ok: true,
      value: "fine",
    });
  });
});

describe("fileAccess Windows names (S3, platform option)", () => {
  const win = (input: string) =>
    attempt(() => resolveInRoot(input, root, { platform: "win32" } as any));

  it.each([
    "CON",
    "con",
    "CON.txt",
    "PRN",
    "AUX.log",
    "NUL",
    "nul.txt",
    "COM1",
    "com9.dat",
    "LPT9",
    "lpt0.txt",
    "CONIN$",
    "CONOUT$",
    "sub/NUL",
    "sub\\COM1.txt",
    "a.txt.",
    "a.txt ",
    "sub/dir./x.txt",
    "sub/dir /x.txt",
  ])("rejects %j as invalid_path on win32", async (input) => {
    const out = await win(input);
    assertThat(!out.ok && hasCode(out, "invalid_path"), {
      what: `resolveInRoot(${JSON.stringify(input)}, win32)`,
      why: "reserved device names and trailing dot/space segments are invalid on Windows",
      expected: "a rejection with code invalid_path",
      actual: describeOutcome(out),
      guidance: "apply the S3 segment regex when platform is win32",
    });
  });

  it.each([
    "console.txt",
    "conn.txt",
    "com10.txt",
    "lpt.txt",
    "nullable.txt",
    "auxiliary.md",
    "a.txt",
    "sub/x.txt",
  ])("allows %j on win32", async (input) => {
    const out = await win(input);
    assertThat(out.ok, {
      what: `resolveInRoot(${JSON.stringify(input)}, win32)`,
      why: "only exact reserved device names (optionally with an extension) are rejected",
      expected: "accepted",
      actual: describeOutcome(out),
      guidance: "anchor the reserved-name regex with ^ and (\\..*)?$",
    });
  });

  it("does not apply the Windows rules when the platform is linux", async () => {
    const out = await attempt(() =>
      resolveInRoot("nul.txt", root, { platform: "linux" } as any),
    );
    expect(out.ok).toBe(true);
  });
});

describe("fileAccess dangerous roots (S2, bad_root)", () => {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  let parent: string;
  let home: string;

  const setHome = (dir: string): void => {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  };
  const restoreHome = (): void => {
    for (const k of ["HOME", "USERPROFILE"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };

  beforeAll(() => {
    parent = makeRoot();
    home = path.join(parent, "fakehome");
    fs.mkdirSync(path.join(home, ".cognigy-plugin"), { recursive: true });
    fs.mkdirSync(path.join(home, "proj"), { recursive: true });
    setHome(home);
  });
  afterAll(() => {
    restoreHome();
    removeDir(parent);
  });
  afterEach(() => setHome(home));

  it("refuses reads and writes when the root is the home directory", async () => {
    const r = await attempt(() => readTextFile("x.txt", home));
    const w = await attempt(() => writeTextFile("x.txt", "X", home));
    assertThat(hasCode(r, "bad_root") && hasCode(w, "bad_root"), {
      what: "root equals os.homedir()",
      why: "the home directory holds credentials and shell config",
      expected: "bad_root for read and write",
      actual: `read ${describeOutcome(r)}; write ${describeOutcome(w)}`,
      guidance: "compare the realpath of the root with os.homedir()",
    });
    expect(fs.existsSync(path.join(home, "x.txt"))).toBe(false);
  });

  it("refuses an ancestor of <home>/.cognigy-plugin (the home's parent)", async () => {
    const r = await attempt(() => readTextFile("x.txt", parent));
    const w = await attempt(() => writeTextFile("x.txt", "X", parent));
    expect(hasCode(r, "bad_root")).toBe(true);
    expect(hasCode(w, "bad_root")).toBe(true);
    expect(fs.existsSync(path.join(parent, "x.txt"))).toBe(false);
  });

  it("refuses a filesystem root (read only: nothing is ever written there)", async () => {
    const fsRoot = path.parse(home).root;
    const r = await attempt(() => readTextFile("x.txt", fsRoot));
    assertThat(hasCode(r, "bad_root"), {
      what: "root is a filesystem root",
      why: "a drive or / root exposes the whole machine",
      expected: "bad_root",
      actual: describeOutcome(r),
      guidance: "reject when path.parse(root).root === root",
    });
  });

  it("allows a project directory below the home directory", async () => {
    const proj = path.join(home, "proj");
    const w = await attempt(() => writeTextFile("ok.txt", "fine", proj));
    expect(w.ok).toBe(true);
    expect(await attempt(() => readTextFile("ok.txt", proj))).toEqual({
      ok: true,
      value: "fine",
    });
  });

  it("bad_root messages are fixed and do not include file contents", async () => {
    fs.writeFileSync(path.join(home, "secret.txt"), "BAD-ROOT-SENTINEL");
    const r = await attempt(() => readTextFile("secret.txt", home));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("BAD-ROOT-SENTINEL");
  });
});
