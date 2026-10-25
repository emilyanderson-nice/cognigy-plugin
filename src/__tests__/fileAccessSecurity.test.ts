import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";
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
  CAN_DIR_SYMLINK,
  CAN_FILE_SYMLINK,
  makeRoot,
  removeDir,
} from "./helpers/fileTestKit.js";

let root: string;
let outside: string;
const SECRET = "TOP-SECRET-SENTINEL-4471";

beforeAll(() => {
  root = makeRoot();
  outside = makeRoot();
  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET);
  fs.mkdirSync(path.join(root, "inner"), { recursive: true });
  fs.writeFileSync(path.join(root, "inner", "ok.txt"), "ok");
});
afterAll(() => {
  removeDir(root);
  removeDir(outside);
});

const rootName = (): string => path.basename(root);

/** Every path that must be rejected, with the reason it is rejected. */
const BAD_PATHS: Array<[string, () => unknown]> = [
  ["empty string", () => ""],
  ["whitespace-free NUL byte", () => "a\u0000b.txt"],
  ["NUL at the end", () => "a.txt\u0000"],
  ["non-string number", () => 42],
  ["non-string null", () => null],
  ["non-string undefined", () => undefined],
  ["parent escape", () => "../x.txt"],
  ["deep parent escape", () => "inner/../../x.txt"],
  ["back-slash parent escape", () => "..\\x.txt"],
  ["leaves and re-enters the root", () => `../${rootName()}/inner/ok.txt`],
  [
    "leaves and re-enters (back slashes)",
    () => `..\\${rootName()}\\inner\\ok.txt`,
  ],
  ["absolute path outside root", () => path.join(outside, "secret.txt")],
  ["the root itself", () => root],
  ["the root itself with a trailing separator", () => root + path.sep],
  ["dot (the root)", () => "."],
  ["UNC backslash", () => "\\\\server\\share\\x.txt"],
  ["UNC forward slash", () => "//server/share/x.txt"],
  ["extended-length prefix", () => "\\\\?\\C:\\Windows\\win.ini"],
  ["device namespace prefix", () => "\\\\.\\C:\\x.txt"],
];

describe("fileAccess security: path rejection", () => {
  it.each(BAD_PATHS)("resolveInRoot rejects %s", async (label, make) => {
    const out = await attempt(() => resolveInRoot(make() as string, root));
    assertThat(!out.ok, {
      what: `resolveInRoot(${label})`,
      why: "only paths strictly inside ROOT may resolve; the root itself is not a file",
      expected: "a rejection (thrown or returned error)",
      actual: describeOutcome(out),
      guidance: "reject before any file system access",
    });
  });

  it.each(BAD_PATHS)("readTextFile rejects %s", async (label, make) => {
    const out = await attempt(() => readTextFile(make() as string, root));
    assertThat(!out.ok, {
      what: `readTextFile(${label})`,
      why: "reads must be confined to ROOT",
      expected: "a rejection",
      actual: describeOutcome(out),
      guidance: "route every read through resolveInRoot",
    });
    if (!out.ok) {
      expect(out.message).not.toContain(SECRET);
      expect(out.message.length).toBeGreaterThan(0);
    }
  });

  it.each(BAD_PATHS)(
    "writeTextFile rejects %s and writes nothing",
    async (label, make) => {
      const before = fs.readdirSync(outside).sort();
      const out = await attempt(() =>
        writeTextFile(make() as string, "X", root),
      );
      assertThat(!out.ok, {
        what: `writeTextFile(${label})`,
        why: "writes must be confined to ROOT",
        expected: "a rejection",
        actual: describeOutcome(out),
        guidance: "route every write through resolveInRoot",
      });
      expect(fs.readdirSync(outside).sort()).toEqual(before);
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(
        SECRET,
      );
    },
  );

  it("accepts a normal relative path with an inner .. that stays inside ROOT", async () => {
    const out = await attempt(() =>
      readTextFile("inner/../inner/ok.txt", root),
    );
    expect(out).toEqual({ ok: true, value: "ok" });
  });

  it("accepts forward and back slash forms of the same inside path", async () => {
    expect(await attempt(() => readTextFile("inner/ok.txt", root))).toEqual({
      ok: true,
      value: "ok",
    });
    expect(await attempt(() => readTextFile("inner\\ok.txt", root))).toEqual({
      ok: true,
      value: "ok",
    });
  });

  it("rejection messages never contain an absolute path outside ROOT or file contents", async () => {
    const target = path.join(outside, "secret.txt");
    const out = await attempt(() => readTextFile(target, root));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).not.toContain(SECRET);
      expect(out.message).not.toContain(outside);
    }
  });

  it("slices a very long input in the message to at most 200 characters of it", async () => {
    const long = "z".repeat(5000) + "/../../x";
    const out = await attempt(() => readTextFile(long, root));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message.length).toBeLessThan(1000);
  });
});

describe("fileAccess security: symlinks", () => {
  // Visible skip chosen at definition time (probed synchronously at module load).
  const itFileLink = CAN_FILE_SYMLINK ? it : it.skip;
  const itDirLink = CAN_DIR_SYMLINK ? it : it.skip;

  itFileLink(
    "rejects a symlink as the final file and does not return the target's content",
    async () => {
      const link = path.join(root, "link-file.txt");
      fs.symlinkSync(path.join(outside, "secret.txt"), link, "file");
      const out = await attempt(() => readTextFile("link-file.txt", root));
      assertThat(!out.ok, {
        what: "read through a symlink to a file outside ROOT",
        why: "any symbolic link component must be rejected",
        expected: "a rejection and no secret in the message",
        actual: describeOutcome(out),
        guidance: "lstat every existing component below ROOT",
      });
      if (!out.ok) expect(out.message).not.toContain(SECRET);
    },
  );

  itFileLink(
    "refuses to write through a symlinked final file even with overwrite",
    async () => {
      const link = path.join(root, "link-write.txt");
      fs.symlinkSync(path.join(outside, "secret.txt"), link, "file");
      const out = await attempt(() =>
        writeTextFile("link-write.txt", "OVERWRITTEN", root, {
          overwrite: true,
        }),
      );
      expect(out.ok).toBe(false);
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(
        SECRET,
      );
    },
  );

  itDirLink(
    "rejects a symlinked directory component for read and write",
    async () => {
      const link = path.join(root, "link-dir");
      fs.symlinkSync(outside, link, "junction");
      const r = await attempt(() => readTextFile("link-dir/secret.txt", root));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain(SECRET);
      const w = await attempt(() =>
        writeTextFile("link-dir/new.txt", "X", root),
      );
      expect(w.ok).toBe(false);
      expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
    },
  );
});

describe("fileAccess security: size and encoding", () => {
  const MAX = 2 * 1024 * 1024;

  it("reads a file of exactly 2 MiB", async () => {
    fs.writeFileSync(path.join(root, "max.txt"), Buffer.alloc(MAX, 0x61));
    const out = await attempt(() => readTextFile("max.txt", root));
    expect(out.ok).toBe(true);
    expect((out as any).value.length).toBe(MAX);
  });

  it("rejects a file of 2 MiB + 1 byte before returning content", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), Buffer.alloc(MAX + 1, 0x61));
    const out = await attempt(() => readTextFile("big.txt", root));
    assertThat(!out.ok, {
      what: "read of 2 MiB + 1 byte",
      why: "the default cap is 2 MiB",
      expected: "a rejection",
      actual: describeOutcome(out),
      guidance: "stat the size before reading and reject over maxBytes",
    });
  });

  it("honours a custom maxBytes on read (exact boundary)", async () => {
    fs.writeFileSync(path.join(root, "ten.txt"), "0123456789");
    expect(
      await attempt(() => readTextFile("ten.txt", root, { maxBytes: 10 })),
    ).toEqual({ ok: true, value: "0123456789" });
    const over = await attempt(() =>
      readTextFile("ten.txt", root, { maxBytes: 9 }),
    );
    expect(over.ok).toBe(false);
  });

  it("writes exactly 2 MiB and rejects 2 MiB + 1 byte before writing", async () => {
    const ok = await attempt(() =>
      writeTextFile("w-max.txt", "a".repeat(MAX), root),
    );
    expect(ok.ok).toBe(true);
    expect((ok as any).value.bytes).toBe(MAX);
    const bad = await attempt(() =>
      writeTextFile("w-over.txt", "a".repeat(MAX + 1), root),
    );
    assertThat(!bad.ok, {
      what: "write of 2 MiB + 1 byte",
      why: "text larger than maxBytes is rejected before writing",
      expected: "a rejection and no file",
      actual: describeOutcome(bad),
      guidance: "compare Buffer.byteLength to maxBytes first",
    });
    expect(fs.existsSync(path.join(root, "w-over.txt"))).toBe(false);
  });

  it("measures the cap in UTF-8 bytes, not characters", async () => {
    // 3 bytes per character: 700000 chars = 2,100,000 bytes > 2 MiB (2,097,152).
    const text = "\u20ac".repeat(700000);
    const bad = await attempt(() => writeTextFile("euro.txt", text, root));
    expect(bad.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "euro.txt"))).toBe(false);
  });

  it.each([
    ["lone continuation byte", [0x80]],
    ["truncated 3-byte sequence", [0xe2, 0x82]],
    ["invalid start byte 0xFF", [0xff, 0x41]],
    ["overlong encoding of NUL", [0xc0, 0x80]],
    ["UTF-16 surrogate encoded in UTF-8", [0xed, 0xa0, 0x80]],
  ])(
    "rejects invalid UTF-8 (%s) instead of replacing it",
    async (_l, bytes) => {
      fs.writeFileSync(path.join(root, "bad.bin"), Buffer.from(bytes));
      const out = await attempt(() => readTextFile("bad.bin", root));
      assertThat(!out.ok, {
        what: `read invalid UTF-8 (${_l})`,
        why: "invalid sequences must be rejected, never replaced with U+FFFD",
        expected: "a rejection",
        actual: describeOutcome(out),
        guidance: "decode with TextDecoder({ fatal: true })",
      });
    },
  );

  it.each(["..foo.txt", "..bar/x.txt", "a..b.txt"])(
    "accepts the name %s (only a real '..' segment escapes)",
    async (name) => {
      fs.mkdirSync(path.join(root, "..bar"), { recursive: true });
      const w = await attempt(() => writeTextFile(name, "dots", root));
      assertThat(w.ok, {
        what: `write ${name}`,
        why: "isInside must not treat a name that merely starts with '..' as an escape",
        expected: "success",
        actual: describeOutcome(w),
        guidance: "compare path segments to '..', not startsWith('..')",
      });
      expect(await attempt(() => readTextFile(name, root))).toEqual({
        ok: true,
        value: "dots",
      });
    },
  );
});
