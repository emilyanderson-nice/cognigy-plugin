import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { wrapCodeWithErrorTrace } from "../utils/errorTrace.js";
import {
  FLOW,
  NODE,
  NODE_PATH,
  SENTINEL,
  listRoot,
  readIn,
  sayNode,
  setupFileEnv,
  type FileEnv,
} from "./helpers/fileHandlerKit.js";
import {
  assertThat,
  callTool,
  makeRoot,
  removeDir,
  sha256,
} from "./helpers/fileTestKit.js";

describe("manage_flow_nodes get: fields and saveTo (F2)", () => {
  let env: FileEnv;
  beforeEach(() => {
    env = setupFileEnv();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    env.cleanup();
  });

  const get = (extra: Record<string, unknown>) =>
    callTool(env.harness.h, {
      operation: "get",
      flowId: FLOW,
      nodeId: NODE,
      ...extra,
    });

  it("without fields the output is unchanged (full node, no missingFields)", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ text: "Hello" }));
    const res = await get({});
    expect(res.id).toBe(NODE);
    expect(res.type).toBe("say");
    expect(res.config).toEqual({ text: "Hello" });
    expect(res).not.toHaveProperty("missingFields");
    expect(res).not.toHaveProperty("saveErrors");
  });

  it("with fields keeps only id plus the listed fields, rebuilding nested objects", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ text: "Hello", a: { b: { c: "deep", d: "other" } }, z: 1 }),
    );
    const res = await get({ fields: ["label", "config.a.b.c"] });
    expect(env.harness.api.get).toHaveBeenCalledTimes(1);
    expect(env.harness.api.get.mock.calls[0]).toEqual([NODE_PATH]);
    expect(res.id).toBe(NODE);
    expect(res.label).toBe("Greeting");
    expect(res.config).toEqual({ a: { b: { c: "deep" } } });
    for (const dropped of ["type", "referenceId"]) {
      assertThat(!(dropped in res), {
        what: `field ${dropped} omitted`,
        why: "with fields, only id and the listed fields are kept",
        expected: `no '${dropped}' key`,
        actual: JSON.stringify(Object.keys(res)),
        guidance: "build the result from id + requested paths only",
      });
    }
    expect(res).not.toHaveProperty("missingFields");
  });

  it("lists non-existent paths in missingFields (requested spelling) and omits them", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ text: "Hello" }));
    const res = await get({
      fields: ["config.text", "config.nope", "config.a.b", "bogus"],
    });
    expect(res.config).toEqual({ text: "Hello" });
    expect(res.missingFields).toEqual(["config.nope", "config.a.b", "bogus"]);
    expect(res).not.toHaveProperty("bogus");
  });

  it("returns the node's own array/number values for fields without saveTo", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ list: [1, 2], n: 0, flag: false }),
    );
    const res = await get({
      fields: ["config.list", "config.n", "config.flag"],
    });
    expect(res.config).toEqual({ list: [1, 2], n: 0, flag: false });
    expect(res).not.toHaveProperty("missingFields");
  });

  it("saveTo writes the exact value, replaces it with { savedTo, bytes, sha256 } and never returns the content", async () => {
    const text = `${SENTINEL}\r\nline two \u{1F600} café\nend`;
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ instructions: text, other: "x" }),
    );
    fs.mkdirSync(path.join(env.root, "out"));
    const ok = await get({
      fields: ["config.instructions", "label"],
      saveTo: { "config.instructions": "out/job.txt" },
    });
    expect(ok.config.instructions).toEqual({
      savedTo: "out/job.txt",
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha256(text),
    });
    expect(ok.label).toBe("Greeting");
    expect(JSON.stringify(ok)).not.toContain(SENTINEL);
    expect(fs.readFileSync(path.join(env.root, "out", "job.txt"))).toEqual(
      Buffer.from(text, "utf8"),
    );
    expect(ok).not.toHaveProperty("saveErrors");
  });

  it("saving into a missing parent directory gives a saveError, writes nothing and keeps the rest intact", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ instructions: SENTINEL, other: "x" }),
    );
    const res = await get({
      fields: ["config.instructions", "label"],
      saveTo: { "config.instructions": "out/job.txt" },
    });
    expect(listRoot(env.root)).toEqual([]);
    expect(res.saveErrors).toHaveLength(1);
    expect(res.saveErrors[0].field).toBe("config.instructions");
    expect(typeof res.saveErrors[0].error).toBe("string");
    expect(JSON.stringify(res.saveErrors)).not.toContain(SENTINEL);
    expect(res.label).toBe("Greeting");
    expect(res.id).toBe(NODE);
  });

  it("returns an error body naming a saveTo key that is not in fields, with no API call and no file", async () => {
    const res = await get({
      fields: ["label"],
      saveTo: { "config.instructions": "a.txt" },
    });
    assertThat(
      typeof res.error === "string" &&
        res.error.includes("config.instructions"),
      {
        what: "saveTo key missing from fields",
        why: "every saveTo key must also be listed in fields",
        expected: "{ error } naming 'config.instructions'",
        actual: JSON.stringify(res),
        guidance: "validate saveTo keys against fields before calling the API",
      },
    );
    expect(env.harness.api.get).not.toHaveBeenCalled();
    expect(listRoot(env.root)).toEqual([]);
  });

  it("reports a per-key saveError for a non-string value while other keys are still written", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ text: "hello", obj: { a: 1 }, n: 5 }),
    );
    const res = await get({
      fields: ["config.text", "config.obj", "config.n"],
      saveTo: {
        "config.obj": "obj.txt",
        "config.text": "text.txt",
        "config.n": "n.txt",
      },
    });
    expect(readIn(env.root, "text.txt")).toBe("hello");
    expect(listRoot(env.root)).toEqual(["text.txt"]);
    expect(res.config.text).toEqual({
      savedTo: "text.txt",
      bytes: 5,
      sha256: sha256("hello"),
    });
    expect(res.config.obj).toEqual({ notSaved: true });
    expect(res.config.n).toBe(5);
    const fields = res.saveErrors.map((e: any) => e.field).sort();
    expect(fields).toEqual(["config.n", "config.obj"]);
    for (const e of res.saveErrors) expect(typeof e.error).toBe("string");
  });

  it("withholds an array on failure but keeps primitives (number, boolean) visible with a not_a_string entry each", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ text: "hello", arr: ["x", "y"], n: 42, flag: false }),
    );
    const res = await get({
      fields: ["config.text", "config.arr", "config.n", "config.flag"],
      saveTo: {
        "config.text": "text.txt",
        "config.arr": "arr.txt",
        "config.n": "n.txt",
        "config.flag": "flag.txt",
      },
    });
    expect(listRoot(env.root)).toEqual(["text.txt"]);
    expect(res.config.text.savedTo).toBe("text.txt");
    expect(res.config.arr).toEqual({ notSaved: true });
    expect(res.config.n).toBe(42);
    expect(res.config.flag).toBe(false);
    const byField = Object.fromEntries(
      res.saveErrors.map((e: any) => [e.field, e]),
    );
    expect(Object.keys(byField).sort()).toEqual([
      "config.arr",
      "config.flag",
      "config.n",
    ]);
    for (const f of ["config.n", "config.flag"]) {
      expect(JSON.stringify(byField[f])).toContain("not_a_string");
    }
  });

  it("reports a saveError for a saveTo field that does not exist and writes nothing for it", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ text: "t" }));
    const res = await get({
      fields: ["config.text", "config.ghost"],
      saveTo: { "config.ghost": "ghost.txt" },
    });
    expect(listRoot(env.root)).toEqual([]);
    expect(res.saveErrors.map((e: any) => e.field)).toEqual(["config.ghost"]);
    expect(res.missingFields).toEqual(["config.ghost"]);
  });

  it("a path error for one key does not stop the others", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ a: "AAA", b: "BBB" }));
    const res = await get({
      fields: ["config.a", "config.b"],
      saveTo: { "config.a": "../escape.txt", "config.b": "b.txt" },
    });
    expect(readIn(env.root, "b.txt")).toBe("BBB");
    expect(listRoot(env.root)).toEqual(["b.txt"]);
    expect(res.saveErrors.map((e: any) => e.field)).toEqual(["config.a"]);
    expect(res.config.a).toEqual({ notSaved: true });
    expect(res.config.b.savedTo).toBe("b.txt");
    expect(fs.existsSync(path.join(path.dirname(env.root), "escape.txt"))).toBe(
      false,
    );
  });

  it("saveErrors never contain file contents or the value being saved", async () => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ a: SENTINEL }));
    const res = await get({
      fields: ["config.a"],
      saveTo: { "config.a": "../escape.txt" },
    });
    expect(JSON.stringify(res.saveErrors)).not.toContain(SENTINEL);
  });

  it("saves a Code node's config.code unwrapped (no error-trace wrapper in the file)", async () => {
    const body = "input.result = 1;\n// über";
    const wrapped = wrapCodeWithErrorTrace({
      code: body,
      flowId: FLOW,
      nodeId: NODE,
      nodeLabel: "Compute",
    });
    env.harness.api.get.mockResolvedValueOnce({
      _id: NODE,
      type: "code",
      label: "Compute",
      config: { code: wrapped },
    });
    const res = await get({
      fields: ["config.code"],
      saveTo: { "config.code": "code.js" },
    });
    expect(fs.readFileSync(path.join(env.root, "code.js"), "utf8")).toBe(body);
    expect(res.config.code).toEqual({
      savedTo: "code.js",
      bytes: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
    });
  });

  it("returns the unwrapped Code node value for fields without saveTo", async () => {
    const wrapped = wrapCodeWithErrorTrace({
      code: "input.x = 2;",
      flowId: FLOW,
      nodeId: NODE,
      nodeLabel: "C",
    });
    env.harness.api.get.mockResolvedValueOnce({
      _id: NODE,
      type: "code",
      config: { code: wrapped },
    });
    const res = await get({ fields: ["config.code"] });
    expect(res.config.code).toBe("input.x = 2;");
  });

  it("refuses to replace an existing file by default and overwrites with overwrite: true", async () => {
    fs.writeFileSync(path.join(env.root, "keep.txt"), "ORIGINAL");
    env.harness.api.get.mockResolvedValue(sayNode({ t: "NEW" }));
    const refused = await get({
      fields: ["config.t"],
      saveTo: { "config.t": "keep.txt" },
    });
    expect(readIn(env.root, "keep.txt")).toBe("ORIGINAL");
    expect(refused.saveErrors.map((e: any) => e.field)).toEqual(["config.t"]);
    expect(refused.config.t).toEqual({ notSaved: true });

    const done = await get({
      fields: ["config.t"],
      saveTo: { "config.t": "keep.txt" },
      overwrite: true,
    });
    expect(readIn(env.root, "keep.txt")).toBe("NEW");
    expect(done.config.t.savedTo).toBe("keep.txt");
    expect(done).not.toHaveProperty("saveErrors");
  });

  it("writes no file when the API call rejects", async () => {
    env.harness.api.get.mockRejectedValueOnce(new Error("boom 500"));
    const res = await get({
      fields: ["config.t"],
      saveTo: { "config.t": "never.txt" },
    });
    expect(typeof res.error).toBe("string");
    expect(listRoot(env.root)).toEqual([]);
  });

  describe("ROOT resolution", () => {
    it("uses COGNIGY_FILE_ROOT when it is an existing absolute directory", async () => {
      env.harness.api.get.mockResolvedValueOnce(sayNode({ t: "in-root" }));
      await get({
        fields: ["config.t"],
        saveTo: { "config.t": "r.txt" },
      });
      expect(readIn(env.root, "r.txt")).toBe("in-root");
    });

    it("falls back to process.cwd() when COGNIGY_FILE_ROOT is unset", async () => {
      const cwdDir = makeRoot();
      try {
        delete process.env.COGNIGY_FILE_ROOT;
        jest.spyOn(process, "cwd").mockReturnValue(cwdDir);
        env.harness.api.get.mockResolvedValueOnce(sayNode({ t: "from-cwd" }));
        await get({ fields: ["config.t"], saveTo: { "config.t": "c.txt" } });
        expect(fs.readFileSync(path.join(cwdDir, "c.txt"), "utf8")).toBe(
          "from-cwd",
        );
        expect(listRoot(env.root)).toEqual([]);
      } finally {
        jest.restoreAllMocks();
        removeDir(cwdDir);
      }
    });

    it.each([
      [
        "a directory that does not exist",
        () => path.join(env.root, "no-such-dir"),
      ],
      ["a relative path", () => "relative/dir"],
      [
        "a regular file",
        () => {
          const f = path.join(env.root, "afile.txt");
          fs.writeFileSync(f, "x");
          return f;
        },
      ],
      ["an empty string", () => ""],
    ])(
      "ignores an invalid COGNIGY_FILE_ROOT (%s) and uses process.cwd()",
      async (_l, make) => {
        const cwdDir = makeRoot();
        try {
          process.env.COGNIGY_FILE_ROOT = make();
          jest.spyOn(process, "cwd").mockReturnValue(cwdDir);
          env.harness.api.get.mockResolvedValueOnce(sayNode({ t: "fallback" }));
          await get({ fields: ["config.t"], saveTo: { "config.t": "f.txt" } });
          assertThat(fs.existsSync(path.join(cwdDir, "f.txt")), {
            what: `COGNIGY_FILE_ROOT is ${_l}`,
            why: "an invalid value must be ignored and the working directory used",
            expected: "f.txt written under process.cwd()",
            actual: `cwd listing: ${JSON.stringify(fs.readdirSync(cwdDir))}`,
            guidance:
              "validate: absolute, exists, is a directory; else use cwd",
          });
        } finally {
          jest.restoreAllMocks();
          removeDir(cwdDir);
        }
      },
    );

    it("re-reads COGNIGY_FILE_ROOT on every call (not cached)", async () => {
      const second = makeRoot();
      try {
        env.harness.api.get.mockResolvedValue(sayNode({ t: "v" }));
        await get({ fields: ["config.t"], saveTo: { "config.t": "one.txt" } });
        process.env.COGNIGY_FILE_ROOT = second;
        await get({ fields: ["config.t"], saveTo: { "config.t": "two.txt" } });
        expect(listRoot(env.root)).toEqual(["one.txt"]);
        expect(fs.readdirSync(second)).toEqual(["two.txt"]);
      } finally {
        removeDir(second);
      }
    });
  });
});
