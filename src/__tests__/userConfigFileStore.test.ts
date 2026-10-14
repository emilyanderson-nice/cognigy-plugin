import {
  describe,
  it,
  expect,
  afterEach,
  jest,
  beforeEach,
} from "@jest/globals";
import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import {
  readUserConfigFile,
  restrictToOwner,
  writeUserConfigFile,
} from "../userConfigFile.js";
import { eq, fail, ok, raises, show } from "./helpers/specAssert.js";

type Runner = (
  command: string,
  args: string[],
) => { status: number | null; stdout?: string; stderr?: string };
type Call = { command: string; args: string[] };

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FAKE_KEY = "fake-key-aaaa";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-cfgstore-"));
  tmpDirs.push(dir);
  return dir;
}
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
function recorder(statusFor: (n: number) => number | null = () => 0): {
  calls: Call[];
  run: Runner;
} {
  const calls: Call[] = [];
  // whoami (SID lookup, H7) always fails here so the env-name fallback is used;
  // it is not recorded, so `calls` holds icacls invocations only.
  const run: Runner = (command, args) => {
    if (command === "whoami") return { status: 1 };
    calls.push({ command, args: [...args] });
    return { status: statusFor(calls.length) };
  };
  return { calls, run };
}

const savedEnv = {
  USERNAME: process.env.USERNAME,
  USERDOMAIN: process.env.USERDOMAIN,
};
function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let stderrSpy: ReturnType<typeof jest.spyOn> | undefined;
afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
  restoreEnv();
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});
function captureStderr(): () => string[] {
  const spy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as never);
  stderrSpy = spy as unknown as typeof stderrSpy;
  return () => spy.mock.calls.map((c) => String(c[0]));
}

// ---------------------------------------------------------------- A
describe("A: readUserConfigFile tolerates a UTF-8 BOM", () => {
  it("returns the same values with or without a leading BOM", () => {
    const dir = freshDir();
    const body = JSON.stringify({ COGNIGY_API_KEY: FAKE_KEY, n: 5 });
    const plain = join(dir, "plain.json");
    const bom = join(dir, "bom.json");
    writeFileSync(plain, body);
    writeFileSync(bom, Buffer.concat([BOM, Buffer.from(body)]));
    eq(
      readUserConfigFile(bom),
      { COGNIGY_API_KEY: FAKE_KEY },
      "readUserConfigFile(file with BOM)",
      "A: a BOM written by Windows editors must not hide the content",
      "Ignore a leading BOM so the JSON parses and string entries are returned.",
    );
    eq(
      readUserConfigFile(bom),
      readUserConfigFile(plain),
      "readUserConfigFile(BOM vs no BOM)",
      "A: result identical to same content without BOM",
      "Return identical results for identical JSON regardless of a BOM.",
    );
  });

  it.each([
    ["BOM then invalid JSON", "{ not json"],
    ["BOM then array", "[1]"],
    ["BOM only", ""],
  ])("still returns {} for %s", (label, text) => {
    const file = join(freshDir(), "config.json");
    writeFileSync(file, Buffer.concat([BOM, Buffer.from(text)]));
    eq(
      readUserConfigFile(file),
      {},
      `readUserConfigFile(${label})`,
      "A: invalid or non-object content yields {}",
      "Return an empty object for unparseable or non-object content.",
    );
  });
});

// ---------------------------------------------------------------- B
describe("B: writeUserConfigFile merge semantics", () => {
  const PROFILES = {
    dev: { apiBaseUrl: "https://api-dev.test", apiKey: "fake-key-dev" },
    prod: { apiBaseUrl: "https://api.test", apiKey: "fake-key-prod" },
  };

  it("replaces string keys, drops absent string keys, preserves non-string keys and defaultProfile", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        COGNIGY_API_KEY: "fake-key-old",
        ONLY_OLD: "gone",
        defaultProfile: "dev",
        profiles: PROFILES,
        extraObj: { a: [1, 2] },
        num: 5,
        arr: ["x"],
        nul: null,
        flag: true,
      }),
    );
    const file = writeUserConfigFile(
      { COGNIGY_API_KEY: "fake-key-new", ADDED: "yes" },
      dir,
    );
    eq(
      file,
      join(dir, "config.json"),
      "writeUserConfigFile return value",
      "B: returns <dir>/config.json",
      "Return the config file path.",
    );
    eq(
      readJson(file),
      {
        COGNIGY_API_KEY: "fake-key-new",
        ADDED: "yes",
        defaultProfile: "dev",
        profiles: PROFILES,
        extraObj: { a: [1, 2] },
        num: 5,
        arr: ["x"],
        nul: null,
        flag: true,
      },
      "writeUserConfigFile(merge into rich file)",
      "B: strings replaced by values, non-strings and defaultProfile preserved",
      "Replace the string entries with the new set, remove stale string keys, keep every non-string key and defaultProfile exactly.",
    );
  });

  it("lets values override defaultProfile when it contains that key", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ defaultProfile: "dev", profiles: PROFILES }),
    );
    const file = writeUserConfigFile({ defaultProfile: "prod" }, dir);
    eq(
      readJson(file),
      { defaultProfile: "prod", profiles: PROFILES },
      "writeUserConfigFile(values has defaultProfile)",
      "B: values.defaultProfile wins over the existing one",
      "Use the defaultProfile supplied in values when present.",
    );
  });

  it("preserves existing profiles when the file starts with a BOM", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "config.json"),
      Buffer.concat([
        BOM,
        Buffer.from(
          JSON.stringify({
            OLD: "x",
            defaultProfile: "dev",
            profiles: PROFILES,
          }),
        ),
      ]),
    );
    const file = writeUserConfigFile({ NEW: "y" }, dir);
    eq(
      readJson(file),
      { NEW: "y", defaultProfile: "dev", profiles: PROFILES },
      "writeUserConfigFile(existing file with BOM)",
      "A+B: a BOM file is a valid existing file, not a corrupt one",
      "Parse the existing BOM-prefixed file and merge into it.",
    );
    ok(
      !existsSync(join(dir, "config.json.bak")),
      "writeUserConfigFile(existing file with BOM)",
      "D: a parseable file must not be backed up",
      "no config.json.bak",
      "config.json.bak exists",
      "Only back up files that are not valid JSON objects.",
    );
  });

  it("creates a missing nested directory and file", () => {
    const dir = join(freshDir(), "a", "b");
    const file = writeUserConfigFile({ K: "v" }, dir);
    eq(
      [file, readJson(file)],
      [join(dir, "config.json"), { K: "v" }],
      "writeUserConfigFile(missing dir)",
      "B: missing dir/file is created",
      "Create the directory tree and the file.",
    );
  });

  it("writes UTF-8 without BOM, 2-space JSON and a trailing newline", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "config.json"),
      Buffer.concat([BOM, Buffer.from('{"x":"1"}')]),
    );
    const file = writeUserConfigFile({ A: "é" }, dir);
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      "writeUserConfigFile(output encoding)",
      "B: output has no BOM",
      "first bytes are not EF BB BF",
      "first bytes are EF BB BF",
      "Write plain UTF-8 without a byte-order mark.",
    );
    eq(
      text,
      JSON.stringify(JSON.parse(text), null, 2) + "\n",
      "writeUserConfigFile(output format)",
      "B: 2-space JSON plus trailing newline",
      "Serialise with two-space indentation and end the file with a single newline.",
    );
    eq(
      JSON.parse(text),
      { A: "é" },
      "writeUserConfigFile(output content)",
      "B: UTF-8 content round-trips",
      "Write non-ASCII text as UTF-8.",
    );
  });

  it("never copies __proto__, constructor or prototype keys from the existing file", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "config.json"),
      '{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"prototype":{"y":2},"keep":{"z":1},"S":"old"}',
    );
    const file = writeUserConfigFile({ S: "new" }, dir);
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    eq(
      Object.keys(parsed).sort(),
      ["S", "keep"],
      "writeUserConfigFile(dangerous existing keys)",
      "B: __proto__/constructor/prototype never copied",
      "Drop those three keys while keeping other non-string keys.",
    );
    ok(
      !/__proto__|"constructor"|"prototype"/.test(text) &&
        ({} as Record<string, unknown>).polluted === undefined,
      "writeUserConfigFile(dangerous existing keys)",
      "B: no prototype pollution and no dangerous key text in output",
      "no such keys in file text and Object.prototype untouched",
      show(text),
      "Never carry over or assign prototype-related keys.",
    );
  });
});

// ---------------------------------------------------------------- C
describe("C: atomic write", () => {
  it("leaves only config.json in the directory after a successful write", () => {
    const dir = freshDir();
    writeUserConfigFile({ A: "1" }, dir);
    writeUserConfigFile({ A: "2" }, dir);
    eq(
      readdirSync(dir),
      ["config.json"],
      "writeUserConfigFile(directory listing)",
      "C: no temporary file remains after success",
      "Remove or rename away every temporary file; the directory holds only config.json.",
    );
  });

  it("throws, leaves the original untouched and no temp file when the rename fails", () => {
    const dir = freshDir();
    const target = join(dir, "config.json");
    mkdirSync(target);
    writeFileSync(join(target, "inner.txt"), "original");
    raises(
      () => writeUserConfigFile({ A: FAKE_KEY }, dir),
      Error,
      "writeUserConfigFile(config.json is a directory)",
      "C: a failed write must surface as an exception",
      "Throw when the new content cannot be moved into place.",
    );
    const leftovers = readdirSync(dir).filter((n) => /\.tmp/.test(n));
    eq(
      leftovers,
      [],
      "writeUserConfigFile(failed rename: temp files)",
      "C: no *.tmp* file is left behind on failure",
      "Clean up the temporary file when the write fails.",
    );
    ok(
      statSync(target).isDirectory() &&
        readFileSync(join(target, "inner.txt"), "utf8") === "original",
      "writeUserConfigFile(failed rename: original)",
      "C: original is untouched on failure",
      "config.json still the original directory with its content",
      "original was modified or replaced",
      "Do not alter the existing target when the write fails.",
    );
  });
});

// ---------------------------------------------------------------- D
describe("D: corrupt existing file is backed up", () => {
  it.each([
    ["invalid JSON", "{ not json"],
    ["truncated JSON", '{"A":"1",'],
    ["array", '["a"]'],
    ["number", "42"],
    ["null", "null"],
    ["string", '"text"'],
    ["empty file", ""],
  ])("backs up %s to config.json.bak and writes only values", (label, text) => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), text);
    const file = writeUserConfigFile({ NEW: "v" }, dir);
    eq(
      readFileSync(join(dir, "config.json.bak"), "utf8"),
      text,
      `writeUserConfigFile(${label}): backup`,
      "D: corrupt original copied to config.json.bak when no backup exists (rotation is covered in userConfigFileBackups.test.ts)",
      "Preserve the unreadable original verbatim in config.json.bak.",
    );
    eq(
      readJson(file),
      { NEW: "v" },
      `writeUserConfigFile(${label}): new file`,
      "D: the new file contains only values",
      "Write only the supplied values after backing up.",
    );
  });

  it("does not create a backup for a valid object", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), '{"A":"1"}');
    writeUserConfigFile({ A: "2" }, dir);
    ok(
      !existsSync(join(dir, "config.json.bak")),
      "writeUserConfigFile(valid existing)",
      "D: only corrupt files are backed up",
      "no config.json.bak",
      "config.json.bak exists",
      "Skip the backup when the existing file is a valid JSON object.",
    );
  });
});

// ---------------------------------------------------------------- E
describe("E: restrictToOwner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  it.each<[NodeJS.Platform]>([["linux"], ["darwin"]])(
    "non-win32 (%s) uses chmod and never runs a command",
    (platform) => {
      const dir = freshDir();
      const file = join(dir, "f.json");
      writeFileSync(file, "{}");
      const rec = recorder();
      eq(
        restrictToOwner(file, "file", { platform, run: rec.run }),
        { ok: true, method: "chmod" },
        `restrictToOwner(file, ${platform})`,
        "E: non-win32 uses chmod",
        "Return ok with method chmod.",
      );
      eq(
        restrictToOwner(dir, "dir", { platform, run: rec.run }),
        { ok: true, method: "chmod" },
        `restrictToOwner(dir, ${platform})`,
        "E: non-win32 uses chmod",
        "Return ok with method chmod.",
      );
      eq(
        rec.calls,
        [],
        `restrictToOwner(${platform}) runner calls`,
        "E: no external command off Windows",
        "Do not invoke the command runner on non-win32 platforms.",
      );
    },
  );

  posixIt("chmods files to 0600 and directories to 0700", () => {
    const dir = freshDir();
    const file = join(dir, "f.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    restrictToOwner(file, "file", { platform: "linux" });
    restrictToOwner(dir, "dir", { platform: "linux" });
    eq(
      [statSync(file).mode & 0o777, statSync(dir).mode & 0o777],
      [0o600, 0o700],
      "restrictToOwner(real chmod)",
      "E: file 0600, dir 0700",
      "Set owner-only permissions: rw for files, rwx for directories.",
    );
  });

  it.each<["file" | "dir", string]>([
    ["file", "FAKEDOM\\alice:(F)"],
    ["dir", "FAKEDOM\\alice:(OI)(CI)F"],
  ])("win32 %s runs icacls with exact args array", (kind, grant) => {
    const target = join(freshDir(), kind === "file" ? "config.json" : "cfg");
    const rec = recorder();
    const result = restrictToOwner(target, kind, {
      platform: "win32",
      run: rec.run,
      user: "FAKEDOM\\alice",
    });
    eq(
      rec.calls,
      [
        {
          command: "icacls",
          args: [target, "/inheritance:r", "/grant:r", grant],
        },
      ],
      `restrictToOwner(${kind}, win32) command`,
      "E: exact icacls invocation as an args array",
      "Invoke icacls with target, /inheritance:r, /grant:r and the owner grant for the kind.",
    );
    eq(
      result,
      { ok: true, method: "icacls" },
      `restrictToOwner(${kind}, win32) result`,
      "E: ok true, method icacls when status is 0",
      "Report success with method icacls.",
    );
  });

  it("win32 default user is USERDOMAIN\\USERNAME from the environment", () => {
    process.env.USERDOMAIN = "FAKEDOM";
    process.env.USERNAME = "fakeuser";
    const rec = recorder();
    restrictToOwner("C:\\x\\config.json", "file", {
      platform: "win32",
      run: rec.run,
    });
    eq(
      rec.calls[0]?.args[3],
      "FAKEDOM\\fakeuser:(F)",
      "restrictToOwner(default user from env)",
      "E: user defaults to ${USERDOMAIN}\\${USERNAME}",
      "Grant the account named by USERDOMAIN and USERNAME.",
    );
  });

  it("win32 default user falls back to os.userInfo().username without env", () => {
    delete process.env.USERDOMAIN;
    delete process.env.USERNAME;
    const rec = recorder();
    restrictToOwner("C:\\x\\config.json", "file", {
      platform: "win32",
      run: rec.run,
    });
    eq(
      rec.calls[0]?.args[3],
      `${userInfo().username}:(F)`,
      "restrictToOwner(default user without env)",
      "E: fallback to os.userInfo().username",
      "Grant the OS-reported username when the environment variables are absent.",
    );
  });

  it.each([
    ["non-zero status", 5],
    ["null status", null],
  ])(
    "win32 never throws on %s and warns by base name only",
    (label, status) => {
      const dir = freshDir();
      const target = join(dir, "config.json");
      const result = restrictToOwner(target, "file", {
        platform: "win32",
        run: () => ({ status, stderr: "boom" }),
        user: "FAKEDOM\\alice",
      });
      ok(
        result.ok === false && result.method === "icacls",
        `restrictToOwner(${label})`,
        "E: failure is reported, not thrown",
        '{ ok: false, method: "icacls", warning }',
        show(result),
        "Return ok:false with method icacls when the command fails.",
      );
      const warning = result.warning ?? "";
      ok(
        warning.includes("config.json") && !warning.includes(target),
        `restrictToOwner(${label}) warning`,
        "E: warning mentions the base name but not the full path",
        "contains config.json, not the full target path",
        show(warning),
        "Name only the base name of the target in the warning.",
      );
    },
  );

  it("win32 never throws when the runner throws", () => {
    const target = join(freshDir(), "config.json");
    let result: ReturnType<typeof restrictToOwner> | undefined;
    try {
      result = restrictToOwner(target, "file", {
        platform: "win32",
        run: () => {
          throw new Error("spawn failed " + FAKE_KEY);
        },
        user: "FAKEDOM\\alice",
      });
    } catch (e) {
      fail(
        "restrictToOwner(runner throws)",
        "E: never throws",
        "returns { ok: false, ... }",
        show(e),
        "Catch runner failures and report them as ok:false.",
      );
    }
    ok(
      result?.ok === false &&
        (result.warning ?? "").includes("config.json") &&
        !(result.warning ?? "").includes(target),
      "restrictToOwner(runner throws)",
      "E: ok:false with a base-name-only warning",
      "ok false, warning names config.json only",
      show(result),
      "Convert exceptions into a warning that does not reveal the full path.",
    );
  });

  it("non-win32 never throws when chmod fails (missing target)", () => {
    const target = join(freshDir(), "missing.json");
    const result = restrictToOwner(target, "file", { platform: "linux" });
    ok(
      result.ok === false && result.method === "chmod",
      "restrictToOwner(chmod on missing file)",
      "E: never throws",
      '{ ok: false, method: "chmod", warning }',
      show(result),
      "Report chmod failures as ok:false.",
    );
  });
});

// ---------------------------------------------------------------- F
describe("F: writeUserConfigFile restricts dir then file and warns", () => {
  beforeEach(() => {
    process.env.USERDOMAIN = "FAKEDOM";
    process.env.USERNAME = "fakeuser";
  });

  it("calls icacls on the directory first, then the file, with the right grants", () => {
    const dir = freshDir();
    const rec = recorder();
    const stderr = captureStderr();
    const file = writeUserConfigFile({ K: FAKE_KEY }, dir, {
      platform: "win32",
      run: rec.run,
    });
    eq(
      rec.calls,
      [
        {
          command: "icacls",
          args: [
            dir,
            "/inheritance:r",
            "/grant:r",
            "FAKEDOM\\fakeuser:(OI)(CI)F",
          ],
        },
        {
          command: "icacls",
          args: [file, "/inheritance:r", "/grant:r", "FAKEDOM\\fakeuser:(F)"],
        },
      ],
      "writeUserConfigFile(restrict calls)",
      "F: directory restricted first, then the file",
      "Restrict the directory, then config.json, once each.",
    );
    eq(
      stderr().filter((l) => l.includes("WARNING")),
      [],
      "writeUserConfigFile(success: stderr)",
      "F: no warning when restriction succeeds",
      "Stay silent when restrictToOwner reports ok.",
    );
  });

  it.each([
    ["directory restriction fails", 1],
    ["file restriction fails", 2],
  ])("writes exactly one WARNING line when the %s", (label, failingCall) => {
    const dir = freshDir();
    const rec = recorder((n) => (n === failingCall ? 1 : 0));
    const stderr = captureStderr();
    const file = writeUserConfigFile({ K: FAKE_KEY }, dir, {
      platform: "win32",
      run: rec.run,
    });
    const lines = stderr();
    ok(
      lines.length === 1 &&
        lines[0].startsWith("[cognigy-plugin] WARNING") &&
        lines[0].trim().split("\n").length === 1,
      `writeUserConfigFile(${label})`,
      "F: one stderr line starting with [cognigy-plugin] WARNING",
      "exactly one single-line warning",
      show(lines),
      "Emit a single-line warning for a failed restriction and nothing else on stderr.",
    );
    ok(
      !lines.join("").includes(FAKE_KEY),
      `writeUserConfigFile(${label}) secrecy`,
      "F: warning carries no key material",
      "no key in stderr",
      "key found in stderr",
      "Never print credentials in warnings.",
    );
    eq(
      readJson(file),
      { K: FAKE_KEY },
      `writeUserConfigFile(${label}) result`,
      "F: the write still succeeds",
      "Complete the write even when permissions could not be tightened.",
    );
  });

  it("still succeeds and warns once when the runner throws", () => {
    const dir = freshDir();
    const stderr = captureStderr();
    const file = writeUserConfigFile({ K: "v" }, dir, {
      platform: "win32",
      run: () => {
        throw new Error("spawn failed");
      },
    });
    const lines = stderr().filter((l) =>
      l.startsWith("[cognigy-plugin] WARNING"),
    );
    eq(
      [lines.length, readJson(file)],
      [1, { K: "v" }],
      "writeUserConfigFile(runner throws)",
      "F: exception becomes one warning, write succeeds",
      "Treat a throwing runner as a failed restriction.",
    );
  });
});

// ---------------------------------------------------------------- G
const winIt = process.platform === "win32" ? it : it.skip;
describe("G: real Windows ACL integration", () => {
  function acl(target: string): string {
    // icacls echoes the path (which contains the user name): strip it first.
    return execFileSync("icacls", [target], { encoding: "utf8" })
      .split(target)
      .join("");
  }
  const forbidden = ["Everyone", "BUILTIN\\Users", "Authenticated Users"];

  winIt("restricts a real file to the current user", () => {
    const dir = freshDir();
    const file = join(dir, "secret.json");
    writeFileSync(file, '{"K":"fake-secret"}');
    const result = restrictToOwner(file, "file");
    const out = acl(file);
    const user = process.env.USERNAME ?? userInfo().username;
    ok(
      result.ok === true && result.method === "icacls",
      "restrictToOwner(real file)",
      "E/G: default runner succeeds on a real file",
      '{ ok: true, method: "icacls" }',
      show(result),
      "Use a real icacls invocation without a shell.",
    );
    ok(
      out.toLowerCase().includes(`${user}:(f)`.toLowerCase()),
      "icacls output for file",
      "G: current user has full control",
      `contains ${user}:(F)`,
      show(out),
      "Grant the current user full control.",
    );
    for (const bad of forbidden) {
      ok(
        !out.includes(bad),
        "icacls output for file",
        `G: ${bad} must have no access`,
        `no ${bad}`,
        show(out),
        "Remove inherited access for broad groups.",
      );
    }
    eq(
      readFileSync(file, "utf8"),
      '{"K":"fake-secret"}',
      "restricted file readability",
      "G: owner can still read the file",
      "Keep the current user able to read the file.",
    );
  });

  winIt(
    "restricts a real directory to the current user and stays deletable",
    () => {
      const dir = join(freshDir(), "cfg");
      mkdirSync(dir);
      const result = restrictToOwner(dir, "dir");
      const out = acl(dir);
      const user = process.env.USERNAME ?? userInfo().username;
      ok(
        result.ok === true && result.method === "icacls",
        "restrictToOwner(real dir)",
        "E/G: default runner succeeds on a real dir",
        '{ ok: true, method: "icacls" }',
        show(result),
        "Use a real icacls invocation without a shell.",
      );
      ok(
        out.toLowerCase().includes(`${user}:(oi)(ci)(f)`.toLowerCase()),
        "icacls output for dir",
        "G: current user has inheritable full control",
        `contains ${user}:(OI)(CI)(F)`,
        show(out),
        "Grant the current user inheritable full control on directories.",
      );
      for (const bad of forbidden) {
        ok(
          !out.includes(bad),
          "icacls output for dir",
          `G: ${bad} must have no access`,
          `no ${bad}`,
          show(out),
          "Remove inherited access for broad groups.",
        );
      }
      writeFileSync(join(dir, "inside.txt"), "x");
      rmSync(dir, { recursive: true });
      ok(
        !existsSync(dir),
        "restricted dir cleanup",
        "G: the directory remains deletable by its owner",
        "directory removed",
        "directory still exists",
        "Never lock the owner out.",
      );
    },
  );
});
