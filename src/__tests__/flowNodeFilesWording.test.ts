import { describe, it, expect } from "@jest/globals";
import { tools } from "../tools/definitions.js";
import { manageFlowNodesSchema } from "../schemas/tools.js";
import { norm, readRepo } from "./helpers/docText.js";
import { assertThat } from "./helpers/fileTestKit.js";

const SKILL_PATH = "plugin/skills/flow-nodes/SKILL.md";
const def = tools.find((t) => t.name === "manage_flow_nodes") as any;
const description = String(def?.description);
const skill = readRepo(SKILL_PATH);
const claudeMd = readRepo(".claude/CLAUDE.md");

const base = {
  operation: "get",
  flowId: "60d5ec49f1a2c8b1a4e0f002",
  nodeId: "60d5ec49f1a2c8b1a4e0f0a1",
};
const ok = (extra: Record<string, unknown>) =>
  manageFlowNodesSchema.safeParse({ ...base, ...extra }).success;

describe("manage_flow_nodes schema (F5)", () => {
  it("accepts fields, saveTo, overwrite and configFromFiles", () => {
    expect(ok({ fields: ["config.instructions", "label"] })).toBe(true);
    expect(
      ok({
        fields: ["config.a"],
        saveTo: { "config.a": "out/a.txt" },
        overwrite: true,
      }),
    ).toBe(true);
    expect(
      ok({ operation: "update", configFromFiles: { instructions: "i.txt" } }),
    ).toBe(true);
  });

  it("accepts the compare operation with field and file", () => {
    expect(
      ok({ operation: "compare", field: "config.code", file: "c.js" }),
    ).toBe(true);
  });

  it("still rejects an unknown operation", () => {
    expect(ok({ operation: "frobnicate" })).toBe(false);
  });

  it("allows exactly 50 fields and rejects 51", () => {
    const f = (n: number) =>
      Array.from({ length: n }, (_v, i) => `config.k${i}`);
    expect(ok({ fields: f(50) })).toBe(true);
    expect(ok({ fields: f(51) })).toBe(false);
  });

  it("limits each field path to 1..200 characters", () => {
    expect(ok({ fields: ["a".repeat(200)] })).toBe(true);
    expect(ok({ fields: ["a".repeat(201)] })).toBe(false);
    expect(ok({ fields: [""] })).toBe(false);
  });

  it("rejects non-array fields, non-string saveTo values and non-boolean overwrite", () => {
    expect(ok({ fields: "config.a" })).toBe(false);
    expect(ok({ fields: [1] })).toBe(false);
    expect(ok({ fields: ["a"], saveTo: { a: 5 } })).toBe(false);
    expect(ok({ fields: ["a"], saveTo: ["a.txt"] })).toBe(false);
    expect(ok({ overwrite: "yes" })).toBe(false);
  });

  it("limits configFromFiles keys to /^[A-Za-z0-9_]{1,64}$/", () => {
    const upd = (k: string) =>
      ok({ operation: "update", configFromFiles: { [k]: "a.txt" } });
    expect(upd("code")).toBe(true);
    expect(upd("A_9")).toBe(true);
    expect(upd("k".repeat(64))).toBe(true);
    expect(upd("k".repeat(65))).toBe(false);
    expect(upd("bad-key")).toBe(false);
    expect(upd("has space")).toBe(false);
    expect(upd("dot.ted")).toBe(false);
    expect(upd("")).toBe(false);
  });

  it("allows 20 configFromFiles entries and rejects 21", () => {
    const m = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_v, i) => [`k${i}`, "a.txt"]),
      );
    expect(ok({ operation: "update", configFromFiles: m(20) })).toBe(true);
    expect(ok({ operation: "update", configFromFiles: m(21) })).toBe(false);
  });

  it("rejects non-string configFromFiles values", () => {
    expect(ok({ operation: "update", configFromFiles: { a: 1 } })).toBe(false);
  });
});

describe("manage_flow_nodes tool definition (F5)", () => {
  it("keeps the tool count at 19", () => {
    expect(tools.length).toBe(19);
  });

  it("lists compare in the operation enum", () => {
    const ops = def.inputSchema.properties.operation.enum as string[];
    expect(ops).toContain("compare");
    for (const op of ["list", "get", "create", "update", "delete", "render"]) {
      expect(ops).toContain(op);
    }
  });

  it.each([
    "fields",
    "saveTo",
    "overwrite",
    "configFromFiles",
    "field",
    "file",
  ])("declares the %s input with a description", (p) => {
    const prop = def.inputSchema.properties[p];
    assertThat(
      prop !== undefined && String(prop.description ?? "").length > 10,
      {
        what: `inputSchema.properties.${p}`,
        why: "the LLM-facing contract must expose the new file inputs",
        expected: "a property with a non-trivial description",
        actual: JSON.stringify(prop),
        guidance:
          "add it to the manage_flow_nodes definition in definitions.ts",
      },
    );
  });

  it("types fields as array and saveTo/configFromFiles as objects", () => {
    expect(def.inputSchema.properties.fields.type).toBe("array");
    expect(def.inputSchema.properties.saveTo.type).toBe("object");
    expect(def.inputSchema.properties.configFromFiles.type).toBe("object");
    expect(def.inputSchema.properties.overwrite.type).toBe("boolean");
  });

  it("no other tool gained the file inputs", () => {
    for (const t of tools as any[]) {
      if (t.name === "manage_flow_nodes") continue;
      const props = Object.keys(t.inputSchema?.properties ?? {});
      for (const p of ["saveTo", "configFromFiles"]) {
        expect(props).not.toContain(p);
      }
    }
  });
});

const TERMS: Array<[string, RegExp]> = [
  ["fields", /\bfields\b/],
  ["saveTo", /saveto/],
  ["configFromFiles", /configfromfiles/],
  ["compare", /\bcompare\b/],
  ["2 MiB", /2 ?mib/],
  ["COGNIGY_FILE_ROOT", /cognigy_file_root/],
  ["symlinks", /symlink|symbolic link/],
  ["overwrite", /\boverwrite\b/],
];

// The tool description is capped at 1000 characters (toolSurfaceBudget), so it
// names the features and points at the skill; the skill holds the rules.
describe("manage_flow_nodes description points at the file features", () => {
  const d = norm(description);

  it.each(["fields", "saveto", "configfromfiles", "compare"])(
    "names %s",
    (term) => {
      assertThat(d.includes(term), {
        what: `description names ${term}`,
        why: "the LLM-facing contract must show that large fields can move through files",
        expected: `the description contains ${term}`,
        actual: description.slice(0, 300),
        guidance: `mention ${term} in the manage_flow_nodes description`,
      });
    },
  );

  it("says the file rules are in the flow-nodes skill", () => {
    assertThat(/file rules[^.]*flow-nodes skill/.test(d), {
      what: "description points at the skill for the file rules",
      why: "the root, deny list and size limits live in the skill, not the description",
      expected: "'file rules ... flow-nodes skill'",
      actual: description.slice(-300),
      guidance: "keep the pointer to the flow-nodes skill",
    });
  });
});

describe.each([[SKILL_PATH, norm(skill)]])(
  "%s mentions the file features",
  (_name, text) => {
    it.each(TERMS)("mentions %s", (label, re) => {
      assertThat(re.test(text as string), {
        what: `${_name} mentions ${label}`,
        why: "agents must learn the large-field workflow from the tool description and the skill",
        expected: `the text contains ${label}`,
        actual: (text as string).slice(0, 300),
        guidance: `add a short large-fields section covering ${label}`,
      });
    });

    it("says content is never returned and files may hold personal data", () => {
      const t = text as string;
      expect(
        /content[^.]{0,80}never returned|never[^.]{0,60}return[^.]{0,40}content/.test(
          t,
        ),
      ).toBe(true);
      expect(/personal data|sensitive|personal information/.test(t)).toBe(true);
    });

    it("states the project working directory as the root and UTF-8 byte-exact handling", () => {
      const t = text as string;
      expect(/working directory/.test(t)).toBe(true);
      expect(/utf-?8/.test(t)).toBe(true);
    });
  },
);

describe(".claude/CLAUDE.md (F5)", () => {
  it("has a sentence about the file-based large-field operations", () => {
    const t = norm(claudeMd);
    expect(/saveto/.test(t) && /configfromfiles/.test(t)).toBe(true);
    expect(/cognigy_file_root/.test(t)).toBe(true);
  });
});

describe("configFromFiles prototype-pollution keys (N4)", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the key %s",
    (key) => {
      const configFromFiles = JSON.parse(`{"${key}":"a.txt"}`);
      const r = manageFlowNodesSchema.safeParse({
        ...base,
        operation: "update",
        configFromFiles,
      });
      assertThat(!r.success, {
        what: `configFromFiles key ${key}`,
        why: "these keys could pollute the prototype chain when merged into config",
        expected: "schema rejection",
        actual: JSON.stringify(r.success),
        guidance:
          "exclude __proto__, constructor and prototype in the key refine",
      });
    },
  );

  it("still accepts ordinary keys such as protocol and constructors", () => {
    expect(
      ok({
        operation: "update",
        configFromFiles: { protocol: "a.txt", constructors: "b.txt" },
      }),
    ).toBe(true);
  });
});

const SAFETY_TERMS: Array<[string, RegExp]> = [
  [
    "credentials and key files in the deny list",
    /credential|key file|\.pem|\.ssh/,
  ],
  ["package manifests in the deny list", /package manifest|package\.json/],
  [
    "shell startup files in the deny list",
    /shell (startup|config)|\.bashrc|\.zshrc/,
  ],
  [
    "git/IDE/CI config in the deny list",
    /\.git\b|\.github|\.vscode|ide|ci config/,
  ],
  ["home directory must not be the root", /home directory/],
  [
    "drive or filesystem root must not be the root",
    /drive root|filesystem root|file system root/,
  ],
  ["byte-exact for valid text", /valid (utf-?8|text)/],
];

describe.each([[SKILL_PATH, norm(skill)]])(
  "%s states the safety rules (S1, S2, N5)",
  (_name, text) => {
    it.each(SAFETY_TERMS)("mentions %s", (label, re) => {
      assertThat(re.test(text as string), {
        what: `${_name}: ${label}`,
        why: "agents and users must know which files are refused and what the root may not be",
        expected: `text matching ${re}`,
        actual: (text as string).slice(0, 300),
        guidance:
          "extend the large-fields section with the deny-list categories and root rule",
      });
    });
  },
);

describe(".claude/CLAUDE.md safety clause (S1, S2)", () => {
  it("mentions the deny list and the home-directory root rule", () => {
    const t = norm(claudeMd);
    const line = t.slice(
      Math.max(0, t.indexOf("configfromfiles") - 600),
      t.indexOf("configfromfiles") + 900,
    );
    expect(/deny|denied|refus/.test(line)).toBe(true);
    expect(/home directory/.test(line)).toBe(true);
  });
});
