import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FLOW,
  NODE,
  listRoot,
  sayNode,
  setupFileEnv,
  type FileEnv,
} from "./helpers/fileHandlerKit.js";
import { assertThat, callTool } from "./helpers/fileTestKit.js";

const REAL_PLATFORM = process.platform;
const fakePlatform = (value: string): void => {
  Object.defineProperty(process, "platform", { value, configurable: true });
};

/** True when the temp file system treats Foo.txt and foo.txt as different files. */
const HOST_CASE_SENSITIVE = ((): boolean => {
  const dir = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"),
      "esc4-case-",
    ),
  );
  try {
    fs.writeFileSync(path.join(dir, "Foo.txt"), "x");
    return !fs.existsSync(path.join(dir, "foo.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe("saveTo duplicate-target detection by platform", () => {
  let env: FileEnv;
  beforeEach(() => {
    env = setupFileEnv();
    fs.mkdirSync(path.join(env.root, "sub"));
  });
  afterEach(() => {
    fakePlatform(REAL_PLATFORM);
    env.cleanup();
  });

  /** Saves config.a and config.b to the two given file names under the faked platform. */
  const save = async (platform: string, fileA: string, fileB: string) => {
    env.harness.api.get.mockResolvedValueOnce(sayNode({ a: "AAA", b: "BBB" }));
    fakePlatform(platform);
    try {
      return await callTool(env.harness.h, {
        operation: "get",
        flowId: FLOW,
        nodeId: NODE,
        fields: ["config.a", "config.b"],
        saveTo: { "config.a": fileA, "config.b": fileB },
      });
    } finally {
      fakePlatform(REAL_PLATFORM);
    }
  };
  const isDuplicate = (res: any): boolean =>
    JSON.stringify(res.saveErrors ?? []).includes("duplicate_target");

  const itCaseSensitiveHost = HOST_CASE_SENSITIVE ? it : it.skip;

  it("linux: Foo.txt and foo.txt are different files, so there is no duplicate_target", async () => {
    const res = await save("linux", "Foo.txt", "foo.txt");
    assertThat(!isDuplicate(res), {
      what: "linux, saveTo Foo.txt and foo.txt",
      why: "case folding applies only on case-insensitive platforms (win32, darwin)",
      expected: "no duplicate_target entry",
      actual: JSON.stringify(res.saveErrors),
      guidance:
        "fold case in the duplicate check only when process.platform is win32 or darwin",
    });
  });

  itCaseSensitiveHost(
    "linux: both files are saved when the host file system is case sensitive",
    async () => {
      const res = await save("linux", "Foo.txt", "foo.txt");
      expect(res.saveErrors).toBeUndefined();
      expect(listRoot(env.root)).toEqual(["Foo.txt", "foo.txt", "sub"]);
      expect(fs.readFileSync(path.join(env.root, "Foo.txt"), "utf8")).toBe(
        "AAA",
      );
      expect(fs.readFileSync(path.join(env.root, "foo.txt"), "utf8")).toBe(
        "BBB",
      );
      expect(res.config.a.savedTo).toBe("Foo.txt");
      expect(res.config.b.savedTo).toBe("foo.txt");
    },
  );

  it.each(["win32", "darwin"])(
    "%s: Foo.txt and foo.txt are duplicates, one is withheld",
    async (platform) => {
      const res = await save(platform, "Foo.txt", "foo.txt");
      assertThat(isDuplicate(res) && res.saveErrors.length === 1, {
        what: `${platform}, saveTo Foo.txt and foo.txt`,
        why: "these platforms use case-insensitive file systems",
        expected: "exactly one saveErrors entry with duplicate_target",
        actual: JSON.stringify(res.saveErrors),
        guidance: "fold case in the duplicate check on win32 and darwin",
      });
      const failed = res.saveErrors[0].field.split(".")[1];
      expect(res.config[failed]).toEqual({ notSaved: true });
      expect(JSON.stringify(res)).not.toContain('AAA"');
      expect(listRoot(env.root).filter((f) => f !== "sub")).toHaveLength(1);
    },
  );

  it.each([
    ["linux", "a.txt", "./a.txt"],
    ["win32", "a.txt", "./a.txt"],
    ["darwin", "a.txt", "./a.txt"],
    ["linux", "a.txt", "sub/../a.txt"],
    ["win32", "a.txt", "sub/../a.txt"],
    ["darwin", "a.txt", "sub/../a.txt"],
  ])(
    "%s: %s and %s resolve to the same file, so they are duplicates",
    async (platform, fileA, fileB) => {
      const res = await save(platform, fileA, fileB);
      assertThat(isDuplicate(res) && res.saveErrors.length === 1, {
        what: `${platform}, saveTo ${fileA} and ${fileB}`,
        why: "the duplicate check compares the resolved path, not the spelling",
        expected: "exactly one saveErrors entry with duplicate_target",
        actual: JSON.stringify(res.saveErrors),
        guidance: "compare resolved paths (relative to ROOT)",
      });
      expect(listRoot(env.root).filter((f) => f !== "sub")).toEqual(["a.txt"]);
    },
  );
});
