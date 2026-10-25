import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { wrapCodeWithErrorTrace } from "../utils/errorTrace.js";
import {
  FLOW,
  NODE,
  NODE_PATH,
  SENTINEL,
  listRoot,
  sayNode,
  setupFileEnv,
  type FileEnv,
} from "./helpers/fileHandlerKit.js";
import { assertThat, callTool, sha256 } from "./helpers/fileTestKit.js";

describe("manage_flow_nodes compare (F4)", () => {
  let env: FileEnv;
  beforeEach(() => {
    env = setupFileEnv();
  });
  afterEach(() => env.cleanup());

  const put = (rel: string, text: string) =>
    fs.writeFileSync(path.join(env.root, rel), Buffer.from(text, "utf8"));
  const compare = (extra: Record<string, unknown> = {}) =>
    callTool(env.harness.h, {
      operation: "compare",
      flowId: FLOW,
      nodeId: NODE,
      field: "config.text",
      file: "f.txt",
      ...extra,
    });
  const live = (value: unknown) =>
    env.harness.api.get.mockResolvedValueOnce(sayNode({ text: value }));

  it("equal text: equal true, matching byte counts and hashes, firstDiffByte null", async () => {
    const t = "same\r\ntext \u{1F600}";
    live(t);
    put("f.txt", t);
    const res = await compare();
    expect(env.harness.api.get).toHaveBeenCalledTimes(1);
    expect(env.harness.api.get.mock.calls[0]).toEqual([NODE_PATH]);
    expect(res).toMatchObject({
      equal: true,
      field: "config.text",
      liveBytes: Buffer.byteLength(t, "utf8"),
      fileBytes: Buffer.byteLength(t, "utf8"),
      liveSha256: sha256(t),
      fileSha256: sha256(t),
      firstDiffByte: null,
    });
  });

  it.each([
    ["difference in the middle", "abcdef", "abcXef", 3],
    ["difference at the first byte", "abc", "Xbc", 0],
    ["live is a prefix of the file", "abc", "abcd", 3],
    ["file is a prefix of live", "abcd", "abc", 3],
    ["live empty, file not", "", "x", 0],
    ["file empty, live not", "x", "", 0],
    ["CRLF vs LF", "a\r\nb", "a\nb", 1],
    [
      "multibyte: e-acute vs e-grave differ in 2nd byte of the char",
      "aé",
      "aè",
      2,
    ],
    ["multibyte after ASCII: euro vs other 3-byte char", "ab€", "ab₫", 4],
    [
      "byte index is in UTF-8 bytes, not characters",
      "\u{1F600}x",
      "\u{1F600}y",
      4,
    ],
  ])("%s: equal false with the exact firstDiffByte", async (_l, a, b, idx) => {
    live(a);
    put("f.txt", b);
    const res = await compare();
    assertThat(
      res.equal === false &&
        res.firstDiffByte === idx &&
        res.liveBytes === Buffer.byteLength(a as string, "utf8") &&
        res.fileBytes === Buffer.byteLength(b as string, "utf8") &&
        res.liveSha256 === sha256(a as string) &&
        res.fileSha256 === sha256(b as string),
      {
        what: `compare: ${_l}`,
        why: "firstDiffByte is the zero-based index of the first differing UTF-8 byte (shorter length for a prefix)",
        expected: `equal false, firstDiffByte ${idx}, byte counts and sha256 of the UTF-8 bytes`,
        actual: JSON.stringify(res),
        guidance: "compare Buffer.from(text,'utf8') byte by byte",
      },
    );
  });

  it("two empty strings are equal with 0 bytes and the sha256 of empty input", async () => {
    live("");
    put("f.txt", "");
    const res = await compare();
    expect(res).toMatchObject({
      equal: true,
      liveBytes: 0,
      fileBytes: 0,
      liveSha256: sha256(""),
      firstDiffByte: null,
    });
  });

  it("never returns file or live content", async () => {
    live(`${SENTINEL} live`);
    put("f.txt", `${SENTINEL} file`);
    const res = await compare();
    expect(res.equal).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("a non-string live field returns an error body (no file comparison)", async () => {
    live({ a: 1 });
    put("f.txt", "x");
    const res = await compare();
    expect(typeof res.error).toBe("string");
    expect(res).not.toHaveProperty("equal");
    live(5);
    const num = await compare();
    expect(typeof num.error).toBe("string");
  });

  it("a missing live field returns an error body", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({}));
    put("f.txt", "x");
    const res = await compare();
    expect(typeof res.error).toBe("string");
    expect(res).not.toHaveProperty("equal");
  });

  it("requires field and file: a missing one is an error and calls no API", async () => {
    const noField = await callTool(env.harness.h, {
      operation: "compare",
      flowId: FLOW,
      nodeId: NODE,
      file: "f.txt",
    });
    expect(typeof noField.error).toBe("string");
    const noFile = await callTool(env.harness.h, {
      operation: "compare",
      flowId: FLOW,
      nodeId: NODE,
      field: "config.text",
    });
    expect(typeof noFile.error).toBe("string");
    const noNode = await callTool(env.harness.h, {
      operation: "compare",
      flowId: FLOW,
      field: "config.text",
      file: "f.txt",
    });
    expect(typeof noNode.error).toBe("string");
    expect(env.harness.api.get).not.toHaveBeenCalled();
  });

  it.each([
    ["missing file", "nope.txt"],
    ["path escape", "../x.txt"],
    ["NUL", "a\u0000b"],
    ["UNC", "//srv/share/x"],
  ])(
    "a file error (%s) returns an error body, never a comparison",
    async (_l, file) => {
      live("x");
      const res = await compare({ file });
      expect(typeof res.error).toBe("string");
      expect(res).not.toHaveProperty("equal");
      expect(res).not.toHaveProperty("firstDiffByte");
    },
  );

  it("an invalid UTF-8 file returns an error body", async () => {
    live("x");
    fs.writeFileSync(path.join(env.root, "f.txt"), Buffer.from([0xff, 0x41]));
    const res = await compare();
    expect(typeof res.error).toBe("string");
    expect(res).not.toHaveProperty("equal");
  });

  it("an oversize file (2 MiB + 1) returns an error body", async () => {
    live("x");
    fs.writeFileSync(
      path.join(env.root, "f.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
    );
    const res = await compare();
    expect(typeof res.error).toBe("string");
    expect(res).not.toHaveProperty("equal");
  });

  it("a Code node compares the unwrapped code against the file", async () => {
    const body = "input.result = 1;\n";
    env.harness.api.get.mockResolvedValueOnce({
      _id: NODE,
      type: "code",
      label: "Compute",
      config: {
        code: wrapCodeWithErrorTrace({
          code: body,
          flowId: FLOW,
          nodeId: NODE,
          nodeLabel: "Compute",
        }),
      },
    });
    put("f.txt", body);
    const res = await compare({ field: "config.code" });
    expect(res).toMatchObject({
      equal: true,
      liveBytes: Buffer.byteLength(body, "utf8"),
      liveSha256: sha256(body),
      firstDiffByte: null,
    });
  });

  it("compare only reads: no PATCH, POST or file written", async () => {
    live("a");
    put("f.txt", "b");
    await compare();
    expect(env.harness.api.patch).not.toHaveBeenCalled();
    expect(env.harness.api.post).not.toHaveBeenCalled();
    expect(listRoot(env.root)).toEqual(["f.txt"]);
    expect(fs.readFileSync(path.join(env.root, "f.txt"), "utf8")).toBe("b");
  });

  it("an API failure returns an error body", async () => {
    env.harness.api.get.mockRejectedValueOnce(new Error("boom"));
    put("f.txt", "b");
    const res = await compare();
    expect(typeof res.error).toBe("string");
    expect(res).not.toHaveProperty("equal");
  });
});
