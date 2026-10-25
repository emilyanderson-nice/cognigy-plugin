import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFlowNodeHarness } from "./helpers/flowNodeHarness.js";
import {
  FLOW,
  NODE,
  PROJECT,
  SENTINEL,
  listRoot,
  sayNode,
  setupFileEnv,
  type FileEnv,
} from "./helpers/fileHandlerKit.js";
import {
  assertThat,
  callTool,
  makeRoot,
  removeDir,
} from "./helpers/fileTestKit.js";

const MIB = 1024 * 1024;

describe("manage_flow_nodes get: failed saveTo never returns content (B1)", () => {
  let env: FileEnv;
  beforeEach(() => {
    env = setupFileEnv();
  });
  afterEach(() => env.cleanup());

  const get = (fields: string[], saveTo: Record<string, string>, extra = {}) =>
    callTool(env.harness.h, {
      operation: "get",
      flowId: FLOW,
      nodeId: NODE,
      fields,
      saveTo,
      ...extra,
    });

  const expectWithheld = (res: any, field: string, sentinelHolder = res) => {
    const key = field.split(".").pop() as string;
    assertThat(
      JSON.stringify(sentinelHolder).includes(SENTINEL) === false &&
        JSON.stringify(res.config[key]) === JSON.stringify({ notSaved: true }),
      {
        what: `failed save of ${field}`,
        why: "content is never returned and the field is replaced by { notSaved: true }",
        expected: `config.${key} = { notSaved: true } and no sentinel anywhere in the result`,
        actual: JSON.stringify(res).slice(0, 400),
        guidance:
          "on any per-key failure replace the field and report only saveErrors",
      },
    );
    expect(res.saveErrors.some((e: any) => e.field === field)).toBe(true);
  };

  it("file already exists (no overwrite)", async () => {
    fs.writeFileSync(path.join(env.root, "x.txt"), "ORIGINAL");
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ a: SENTINEL, b: "BBB" }),
    );
    const res = await get(["config.a", "config.b"], {
      "config.a": "x.txt",
      "config.b": "b.txt",
    });
    expectWithheld(res, "config.a");
    expect(fs.readFileSync(path.join(env.root, "x.txt"), "utf8")).toBe(
      "ORIGINAL",
    );
    expect(fs.readFileSync(path.join(env.root, "b.txt"), "utf8")).toBe("BBB");
    expect(res.config.b.savedTo).toBe("b.txt");
  });

  it("escaping path", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ a: SENTINEL, b: "BBB" }),
    );
    const res = await get(["config.a", "config.b"], {
      "config.a": "../escape.txt",
      "config.b": "b.txt",
    });
    expectWithheld(res, "config.a");
    expect(listRoot(env.root)).toEqual(["b.txt"]);
  });

  it("denied path (.env)", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ a: SENTINEL, b: "BBB" }),
    );
    const res = await get(["config.a", "config.b"], {
      "config.a": ".env",
      "config.b": "b.txt",
    });
    expectWithheld(res, "config.a");
    expect(JSON.stringify(res.saveErrors)).toContain("denied_path");
    expect(listRoot(env.root)).toEqual(["b.txt"]);
  });

  it("write error (parent directory missing)", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ a: SENTINEL, b: "BBB" }),
    );
    const res = await get(["config.a", "config.b"], {
      "config.a": "missing/dir/a.txt",
      "config.b": "b.txt",
    });
    expectWithheld(res, "config.a");
    expect(listRoot(env.root)).toEqual(["b.txt"]);
  });

  it("duplicate target: one wins, the other is withheld", async () => {
    env.harness.api.get.mockResolvedValueOnce(
      sayNode({ a: `${SENTINEL}-A`, b: `${SENTINEL}-B` }),
    );
    const res = await get(["config.a", "config.b"], {
      "config.a": "same.txt",
      "config.b": "same.txt",
    });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect(listRoot(env.root)).toEqual(["same.txt"]);
    expect(res.saveErrors).toHaveLength(1);
    const failed = res.saveErrors[0].field as string;
    const winner = failed === "config.a" ? "config.b" : "config.a";
    expect(res.config[failed.split(".")[1]]).toEqual({ notSaved: true });
    expect(res.config[winner.split(".")[1]].savedTo).toBe("same.txt");
    expect(fs.readFileSync(path.join(env.root, "same.txt"), "utf8")).toBe(
      `${SENTINEL}-${winner === "config.a" ? "A" : "B"}`,
    );
  });

  it("total cap: five 2 MiB values fit in 10 MiB, the sixth is withheld with total_cap", async () => {
    const big = (c: string, lead = ""): string =>
      lead + c.repeat(2 * MIB - lead.length);
    const config: Record<string, string> = {};
    const saveTo: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      config[`k${i}`] = big("a");
      saveTo[`config.k${i}`] = `k${i}.txt`;
    }
    config.k6 = big("b", SENTINEL);
    saveTo["config.k6"] = "k6.txt";
    env.harness.api.get.mockResolvedValueOnce(sayNode(config));
    const res = await get(Object.keys(saveTo), saveTo);
    for (let i = 1; i <= 5; i++) {
      expect(res.config[`k${i}`].savedTo).toBe(`k${i}.txt`);
      expect(res.config[`k${i}`].bytes).toBe(2 * MIB);
    }
    expectWithheld(res, "config.k6");
    expect(JSON.stringify(res.saveErrors)).toContain("total_cap");
    expect(listRoot(env.root)).toEqual([
      "k1.txt",
      "k2.txt",
      "k3.txt",
      "k4.txt",
      "k5.txt",
    ]);
  });

  it("an unreasonable root (home directory) fails every key with bad_root and writes nothing", async () => {
    const parent = makeRoot();
    const home = path.join(parent, "home");
    fs.mkdirSync(home);
    const saved = [process.env.HOME, process.env.USERPROFILE];
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.COGNIGY_FILE_ROOT = home;
      env.harness.api.get.mockResolvedValueOnce(sayNode({ a: SENTINEL }));
      const res = await get(["config.a"], { "config.a": "a.txt" });
      expectWithheld(res, "config.a");
      expect(JSON.stringify(res.saveErrors)).toContain("bad_root");
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      for (const [i, k] of (["HOME", "USERPROFILE"] as const).entries()) {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      }
      removeDir(parent);
    }
  });
});

describe("backup gate on a fresh handler (no seed)", () => {
  let env: FileEnv;
  beforeEach(() => {
    env = setupFileEnv();
  });
  afterEach(() => env.cleanup());

  const fresh = () => {
    const h = makeFlowNodeHarness();
    h.api.get.mockImplementation((async (p: string) =>
      p === `/v2.0/flows/${FLOW}`
        ? { _id: FLOW, projectReference: PROJECT }
        : { ...sayNode({ text: "old" }), type: "customNode" }) as any);
    h.api.patch.mockResolvedValue({ _id: NODE } as any);
    return h;
  };

  it("update with configFromFiles is still gated: backup_not_offered, changed false, no PATCH", async () => {
    fs.writeFileSync(path.join(env.root, "a.txt"), "FILE-TEXT");
    const h = fresh();
    const res = await callTool(h.h, {
      operation: "update",
      flowId: FLOW,
      nodeId: NODE,
      configFromFiles: { text: "a.txt" },
    });
    assertThat(res.error === "backup_not_offered" && res.changed === false, {
      what: "first update in a session with configFromFiles",
      why: "the first-change backup gate must not be bypassed by file-sourced config",
      expected: "{ error: 'backup_not_offered', changed: false } and no PATCH",
      actual: JSON.stringify(res).slice(0, 300),
      guidance: "run the gate before reading files / patching",
    });
    expect(h.api.patch).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("FILE-TEXT");
    expect(fs.readFileSync(path.join(env.root, "a.txt"), "utf8")).toBe(
      "FILE-TEXT",
    );
  });

  it("compare is not gated", async () => {
    fs.writeFileSync(path.join(env.root, "a.txt"), "old");
    const h = fresh();
    const res = await callTool(h.h, {
      operation: "compare",
      flowId: FLOW,
      nodeId: NODE,
      field: "config.text",
      file: "a.txt",
    });
    expect(res.error).toBeUndefined();
    expect(res.equal).toBe(true);
    expect(h.api.patch).not.toHaveBeenCalled();
  });

  it("get with fields and saveTo is not gated", async () => {
    const h = fresh();
    const res = await callTool(h.h, {
      operation: "get",
      flowId: FLOW,
      nodeId: NODE,
      fields: ["config.text"],
      saveTo: { "config.text": "t.txt" },
    });
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(env.root, "t.txt"), "utf8")).toBe("old");
  });
});
