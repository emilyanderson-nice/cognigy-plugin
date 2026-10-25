import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { ERROR_TRACE_MARKER, unwrapCode } from "../utils/errorTrace.js";
import {
  FLOW,
  NODE,
  NODE_PATH,
  PROJECT,
  SENTINEL,
  listRoot,
  sayNode,
  setupFileEnv,
  type FileEnv,
} from "./helpers/fileHandlerKit.js";
import { assertThat, callTool, sha256 } from "./helpers/fileTestKit.js";

describe("manage_flow_nodes update: configFromFiles (F3)", () => {
  let env: FileEnv;
  let node: any;
  beforeEach(() => {
    env = setupFileEnv();
    node = { ...sayNode({ text: "old" }), type: "customNode" };
    env.harness.api.get.mockImplementation((async (p: string) =>
      p === `/v2.0/flows/${FLOW}`
        ? { _id: FLOW, projectReference: PROJECT }
        : node) as any);
    env.harness.api.patch.mockResolvedValue({ _id: NODE } as any);
  });
  afterEach(() => env.cleanup());

  const put = (rel: string, text: string) =>
    fs.writeFileSync(path.join(env.root, rel), Buffer.from(text, "utf8"));
  const update = (extra: Record<string, unknown>) =>
    callTool(env.harness.h, {
      operation: "update",
      flowId: FLOW,
      nodeId: NODE,
      ...extra,
    });
  const patches = () => env.harness.api.patch.mock.calls;

  it("reads each file into its config key and PATCHes the exact text", async () => {
    const a = "line one\r\nline two \u{1F600}\n";
    put("a.txt", a);
    put("b.txt", "B");
    const res = await update({
      configFromFiles: { text: "a.txt", other: "b.txt" },
    });
    expect(res.updated).toBe(true);
    expect(patches()).toHaveLength(1);
    expect(patches()[0][0]).toBe(NODE_PATH);
    const cfg = (patches()[0][1] as any).config;
    expect(cfg.text).toBe(a);
    expect(cfg.other).toBe("B");
  });

  it("lists configFromFiles entries with bytes and sha256 and no content", async () => {
    const text = `${SENTINEL} café \u{1F600}`;
    put("a.txt", text);
    const res = await update({ configFromFiles: { text: "a.txt" } });
    expect(res.configFromFiles).toEqual([
      {
        field: "text",
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: sha256(text),
      },
    ]);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("merges file keys with inline config for other keys", async () => {
    put("a.txt", "FROMFILE");
    await update({
      config: { inline: "I" },
      configFromFiles: { text: "a.txt" },
    });
    const cfg = (patches()[0][1] as any).config;
    expect(cfg.inline).toBe("I");
    expect(cfg.text).toBe("FROMFILE");
  });

  it("a key present in both config and configFromFiles is an error body naming the key, with no API call", async () => {
    put("a.txt", "X");
    const res = await update({
      config: { text: "inline" },
      configFromFiles: { text: "a.txt" },
    });
    assertThat(typeof res.error === "string" && res.error.includes("text"), {
      what: "duplicate key in config and configFromFiles",
      why: "the source of the value would be ambiguous",
      expected: "{ error } naming 'text'",
      actual: JSON.stringify(res),
      guidance: "reject before any file or API access",
    });
    expect(env.harness.api.get).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(0);
  });

  it.each([
    ["missing file", (): Record<string, string> => ({ text: "missing.txt" })],
    ["path escape", (): Record<string, string> => ({ text: "../x.txt" })],
    ["NUL in path", (): Record<string, string> => ({ text: "a\u0000.txt" })],
    ["UNC path", (): Record<string, string> => ({ text: "\\\\srv\\share\\x" })],
    ["empty path", (): Record<string, string> => ({ text: "" })],
  ])(
    "a file error (%s) returns { error, field } and makes no API call",
    async (_l, make) => {
      const res = await update({ configFromFiles: make() });
      assertThat(
        typeof res.error === "string" &&
          res.error.length > 0 &&
          res.field === "text",
        {
          what: `configFromFiles with ${_l}`,
          why: "any file error aborts the whole update",
          expected: "{ error: <fixed text>, field: 'text' } and no API call",
          actual: JSON.stringify(res),
          guidance: "read all files first; return before touching the API",
        },
      );
      expect(env.harness.api.get).not.toHaveBeenCalled();
      expect(patches()).toHaveLength(0);
    },
  );

  it("a bad second file means no partial update (the good first file is not sent)", async () => {
    put("good.txt", "GOOD");
    const res = await update({
      configFromFiles: { first: "good.txt", second: "missing.txt" },
    });
    expect(res.field).toBe("second");
    expect(patches()).toHaveLength(0);
    expect(env.harness.api.get).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 and oversize files as { error, field } without leaking content", async () => {
    fs.writeFileSync(
      path.join(env.root, "bad.bin"),
      Buffer.from([0xff, 0xfe, 0x41]),
    );
    const bad = await update({ configFromFiles: { text: "bad.bin" } });
    expect(bad.field).toBe("text");
    fs.writeFileSync(
      path.join(env.root, "big.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
    );
    const big = await update({ configFromFiles: { text: "big.txt" } });
    expect(big.field).toBe("text");
    expect(JSON.stringify([bad, big])).not.toContain("aaaaaaaaaa");
    expect(patches()).toHaveLength(0);
  });

  it("an error for a file does not echo the file contents", async () => {
    put("secret.txt", SENTINEL);
    const res = await update({
      config: { text: "x" },
      configFromFiles: { text: "secret.txt" },
    });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("Code node: file text is wrapped by the existing wrapper and the file stays untouched", async () => {
    const code = "// über\r\ninput.result = 1;\n";
    put("code.js", code);
    node = {
      _id: NODE,
      type: "code",
      label: "Compute",
      config: { code: "old" },
    };
    const res = await update({ configFromFiles: { code: "code.js" } });
    expect(res.updated).toBe(true);
    const patched = (patches()[0][1] as any).config.code as string;
    expect(patched).toContain(ERROR_TRACE_MARKER);
    expect(unwrapCode(patched)).toBe(code);
    expect(fs.readFileSync(path.join(env.root, "code.js"), "utf8")).toBe(code);
    expect(listRoot(env.root)).toEqual(["code.js"]);
    // the reported hash is of the author's file, not of the wrapped code
    expect(res.configFromFiles).toEqual([
      {
        field: "code",
        bytes: Buffer.byteLength(code, "utf8"),
        sha256: sha256(code),
      },
    ]);
  });

  it("Code node: the file text is wrapped exactly once", async () => {
    const code = "input.x = 3;";
    put("code.js", code);
    node = { _id: NODE, type: "code", label: "C", config: { code: "old" } };
    await update({ configFromFiles: { code: "code.js" } });
    const patched = (patches()[0][1] as any).config.code as string;
    expect(patched.split(ERROR_TRACE_MARKER).length - 1).toBe(1);
  });

  it("aiAgentJob: config.aiAgent is still re-sent when the update carries file-sourced keys", async () => {
    put("instr.txt", "Be helpful.");
    node = {
      _id: NODE,
      type: "aiAgentJob",
      label: "Agent",
      config: { aiAgent: "ref-uuid", instructions: "old" },
    };
    await update({ configFromFiles: { instructions: "instr.txt" } });
    const cfg = (patches()[0][1] as any).config;
    expect(cfg.instructions).toBe("Be helpful.");
    expect(cfg.aiAgent).toBe("ref-uuid");
    expect(cfg).not.toHaveProperty("preview");
  });

  it("rejects an invalid configFromFiles key (not [A-Za-z0-9_]{1,64}) with no API call", async () => {
    put("a.txt", "X");
    for (const key of ["bad-key", "has space", "dot.ted", "", "k".repeat(65)]) {
      const res = await update({ configFromFiles: { [key]: "a.txt" } });
      expect(typeof res.error === "string").toBe(true);
    }
    expect(env.harness.api.get).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(0);
  });

  it("accepts exactly 20 entries and rejects 21, with no API call for the 21", async () => {
    put("a.txt", "X");
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_v, i) => [`k${i}`, "a.txt"]),
    );
    const ok = await update({ configFromFiles: twenty });
    expect(ok.updated).toBe(true);
    env.harness.api.get.mockClear();
    env.harness.api.patch.mockClear();
    const twentyOne = { ...twenty, k20: "a.txt" };
    const bad = await update({ configFromFiles: twentyOne });
    expect(typeof bad.error === "string").toBe(true);
    expect(env.harness.api.get).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(0);
  });

  it("update without configFromFiles is unchanged (no configFromFiles in the result)", async () => {
    const res = await update({ config: { text: "inline" } });
    expect(res.updated).toBe(true);
    expect(res).not.toHaveProperty("configFromFiles");
    expect((patches()[0][1] as any).config.text).toBe("inline");
  });
});
