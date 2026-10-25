import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTextFile, writeTextFile } from "../utils/fileAccess.js";
import {
  assertThat,
  attempt,
  describeOutcome,
  makeRoot,
  removeDir,
  sha256,
} from "./helpers/fileTestKit.js";

let root: string;
beforeAll(() => {
  root = makeRoot();
});
afterAll(() => removeDir(root));

const read = (input: string, opts?: { maxBytes?: number }) =>
  attempt(() => readTextFile(input, root, opts));
const write = (
  input: string,
  text: string,
  opts?: { overwrite?: boolean; maxBytes?: number },
) => attempt(() => writeTextFile(input, text, root, opts));

describe("fileAccess: read and write round trips", () => {
  it("writes exact bytes and returns { path, bytes, sha256 } with a relative forward-slash path", async () => {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    const text = "hello\nworld";
    const out = await write("sub/a.txt", text);
    assertThat(out.ok, {
      what: "writeTextFile sub/a.txt",
      why: "a relative path whose parent exists inside ROOT must be writable",
      expected: "success",
      actual: describeOutcome(out),
      guidance: "resolve relative inputs against ROOT",
    });
    expect((out as any).value).toEqual({
      path: "sub/a.txt",
      bytes: 11,
      sha256: sha256(text),
    });
    expect(fs.readFileSync(path.join(root, "sub", "a.txt"))).toEqual(
      Buffer.from(text, "utf8"),
    );
  });

  it("accepts back slashes and returns the path with forward slashes", async () => {
    fs.mkdirSync(path.join(root, "bs"), { recursive: true });
    const out = await write("bs\\b.txt", "x");
    assertThat(out.ok && (out as any).value.path === "bs/b.txt", {
      what: "write with a back-slash relative path",
      why: "Windows-style separators must resolve like forward slashes",
      expected: "success with path 'bs/b.txt'",
      actual: describeOutcome(out),
      guidance: "normalise separators before resolving",
    });
  });

  it("accepts an absolute path inside ROOT", async () => {
    const abs = path.join(root, "abs.txt");
    const out = await write(abs, "abs");
    expect(out.ok).toBe(true);
    expect((out as any).value.path).toBe("abs.txt");
    const back = await read(abs);
    expect(back).toEqual({ ok: true, value: "abs" });
  });

  it("preserves CRLF and LF byte-exact in a write then read round trip", async () => {
    const text = "a\r\nb\nc\r\n\r\nd";
    const w = await write("eol.txt", text);
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "eol.txt"))).toEqual(
      Buffer.from([
        0x61, 0x0d, 0x0a, 0x62, 0x0a, 0x63, 0x0d, 0x0a, 0x0d, 0x0a, 0x64,
      ]),
    );
    expect(await read("eol.txt")).toEqual({ ok: true, value: text });
  });

  it("keeps a UTF-8 BOM as U+FEFF and does not add one on write", async () => {
    fs.writeFileSync(
      path.join(root, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]),
    );
    const r = await read("bom.txt");
    expect(r).toEqual({ ok: true, value: "﻿hi" });
    await write("nobom.txt", "hi");
    expect(fs.readFileSync(path.join(root, "nobom.txt"))).toEqual(
      Buffer.from("hi", "utf8"),
    );
  });

  it("round-trips emoji and combining marks without normalisation", async () => {
    const text = "café \u{1F600} é 中文";
    const w = await write("uni.txt", text);
    expect((w as any).value.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect((w as any).value.sha256).toBe(sha256(text));
    const r = await read("uni.txt");
    expect(r).toEqual({ ok: true, value: text });
    expect((r as any).value.length).toBe(text.length);
  });

  it("writes and reads an empty file (0 bytes, sha256 of empty input)", async () => {
    const w = await write("empty.txt", "");
    expect((w as any).value).toEqual({
      path: "empty.txt",
      bytes: 0,
      sha256: sha256(""),
    });
    expect(await read("empty.txt")).toEqual({ ok: true, value: "" });
  });
});

describe("fileAccess: overwrite semantics", () => {
  it("refuses to replace an existing file by default and leaves it untouched", async () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "ORIGINAL");
    const out = await write("keep.txt", "NEW");
    assertThat(!out.ok, {
      what: "write over an existing file without overwrite",
      why: "overwrite defaults to false (exclusive create)",
      expected: "an error",
      actual: describeOutcome(out),
      guidance: "open with the exclusive-create flag unless overwrite is true",
    });
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe(
      "ORIGINAL",
    );
  });

  it("replaces the file when overwrite is true", async () => {
    fs.writeFileSync(path.join(root, "rep.txt"), "ORIGINAL LONGER CONTENT");
    const out = await write("rep.txt", "NEW", { overwrite: true });
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "rep.txt"), "utf8")).toBe("NEW");
  });

  it("creates a new file when overwrite is true and none exists", async () => {
    const out = await write("fresh.txt", "F", { overwrite: true });
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "fresh.txt"), "utf8")).toBe("F");
  });

  it("does not create missing parent directories", async () => {
    const out = await write("nope/deeper/x.txt", "x");
    assertThat(!out.ok, {
      what: "write into a missing directory",
      why: "the PARENT directory must already exist (no mkdir)",
      expected: "an error",
      actual: describeOutcome(out),
      guidance: "do not call mkdir in writeTextFile",
    });
    expect(fs.existsSync(path.join(root, "nope"))).toBe(false);
  });

  it("reports a plain error when reading a path through a missing directory", async () => {
    const out = await read("missing-dir/x.txt");
    expect(out.ok).toBe(false);
  });

  it("reports an error when the file to read does not exist", async () => {
    const out = await read("does-not-exist.txt");
    expect(out.ok).toBe(false);
  });

  it("refuses to read a directory", async () => {
    fs.mkdirSync(path.join(root, "adir"), { recursive: true });
    const out = await read("adir");
    assertThat(!out.ok, {
      what: "read a directory",
      why: "the target must be a regular file",
      expected: "an error",
      actual: describeOutcome(out),
      guidance: "check stat.isFile() before reading",
    });
  });

  const posix = process.platform === "win32" ? it.skip : it;
  posix("creates files with mode 0o600 (POSIX only)", async () => {
    await write("mode.txt", "m");
    const mode = fs.statSync(path.join(root, "mode.txt")).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });
});
