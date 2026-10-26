/**
 * M3 docs wording for msgChars and the Log-node debugging recipe. Pure reads of
 * the tool definition and repo docs.
 */
import { describe, it, expect } from "@jest/globals";

import {
  LOG_HEADING,
  listDef,
  norm,
  overclaims,
  readRepo,
  section,
} from "./helpers/docText.js";
import { expectExact } from "./helpers/logFixtures.js";

const BANNED = [
  "retained about",
  "kept about",
  "only returned when asked",
  "lags a few seconds",
];
const spec = (what: string) => ({
  what,
  why: "M3: msgChars and the Log-node recipe are documented as observed, with the personal-data caution, and without unevidenced claims",
  fix: "add the missing wording to the named text",
});

const msgProp = () => listDef.inputSchema.properties.msgChars as any;
const flowSection = () =>
  section(
    readRepo("plugin/skills/flow-nodes/SKILL.md"),
    /^## Debugging tool calls with Log nodes/,
  );
const troubleSection = () =>
  section(
    readRepo("plugin/skills/troubleshooting/SKILL.md"),
    /^## Read the project logs/,
  );

describe("msgChars docs: definition", () => {
  it("list_resources has a msgChars property with the 100..4000 range", () => {
    const p = msgProp();
    expectExact(
      [
        p !== undefined,
        ["integer", "number"].includes(p?.type),
        p?.minimum,
        p?.maximum,
      ],
      [true, true, 100, 4000],
      spec("msgChars schema property"),
    );
  });

  it("its description names the entries view, the range and the default of 500, and that text is still scrubbed", () => {
    const t = norm(String(msgProp()?.description ?? ""));
    expectExact(
      [
        t.includes("entries"),
        t.includes("100"),
        t.includes("4000"),
        t.includes("500"),
        t.includes("scrub"),
      ],
      [true, true, true, true, true],
      spec("msgChars description"),
    );
  });

  it("the list_resources description mentions msgChars", () => {
    expect(norm(String(listDef.description))).toContain("msgchars");
  });

  it("the new definition texts have no over-claims and no banned phrases", () => {
    const texts = [
      String(msgProp()?.description ?? ""),
      String(listDef.description),
    ];
    for (const t of texts) {
      expectExact(
        [overclaims(t), BANNED.filter((b) => norm(t).includes(b))],
        [[], []],
        spec("definition over-claims"),
      );
    }
  });
});

describe("msgChars docs: troubleshooting skill", () => {
  it("'## Read the project logs' mentions msgChars", () => {
    const t = norm(troubleSection());
    expectExact(
      [t.length > 0, t.includes("msgchars")],
      [true, true],
      spec("troubleshooting SKILL.md msgChars"),
    );
  });
});

describe("msgChars docs: .claude/CLAUDE.md", () => {
  it("the Project logs paragraph has a separate sentence on msgChars", () => {
    const sentences = norm(section(readRepo(".claude/CLAUDE.md"), LOG_HEADING))
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.includes("msgchars"));
    expectExact(
      [
        sentences.length >= 1,
        sentences.some(
          (s) => !s.includes("meta.text") && !s.includes("meta.urltoken"),
        ),
      ],
      [true, true],
      spec("CLAUDE.md msgChars sentence"),
    );
  });
});

describe("Log-node recipe in the flow-nodes skill", () => {
  const raw = () => flowSection();

  it("has the section '## Debugging tool calls with Log nodes'", () => {
    expect(raw().length).toBeGreaterThan(0);
  });

  it.each([
    ["[tool-values]"],
    ["args={{JSON.stringify(input.aiAgent && input.aiAgent.toolArgs)}}"],
    ["[tool-result] result={{JSON.stringify(input.result)}}"],
    [
      "[kb-meta] n={{((context.knowledgeSearch&&context.knowledgeSearch.data&&context.knowledgeSearch.data.topK)||[]).length}} meta={{JSON.stringify(((context.knowledgeSearch&&context.knowledgeSearch.data&&context.knowledgeSearch.data.topK)||[]).map(function(c){ return { d: c.distance, m: c.chunkMetaData } }))}}",
    ],
    ["storeLocation"],
    ["context"],
    ["topK"],
    ["chunkMetaData"],
    ["input.aiAgent.toolArgs"],
    ["msgChars: 4000"],
  ])("contains the exact text %s", (needle) => {
    expectExact(raw().includes(needle), true, spec(`recipe text ${needle}`));
  });

  it("says input.aiAgent.toolId was empty and the literal tool name is used", () => {
    const t = norm(raw());
    expectExact(
      [
        t.includes("input.aiagent.toolid"),
        /toolid[^.]{0,80}empty/.test(t),
        t.includes("literal"),
      ],
      [true, true, true],
      spec("toolId statement"),
    );
  });

  it("labels input.result for a knowledge tool as not tested", () => {
    const sentences = norm(raw()).split(/(?<=[.!?])\s+/);
    expectExact(
      sentences.some(
        (s) =>
          s.includes("not tested") &&
          s.includes("input.result") &&
          s.includes("knowledge"),
      ),
      true,
      spec("not tested label"),
    );
  });

  it("labels the findings observed and carries a personal-data caution", () => {
    const t = norm(raw());
    expectExact(
      [t.includes("observed"), t.includes("personal data")],
      [true, true],
      spec("observed label and caution"),
    );
  });

  it("has no over-claims and no banned phrases", () => {
    expectExact(
      [overclaims(raw()), BANNED.filter((b) => norm(raw()).includes(b))],
      [[], []],
      spec("recipe over-claims"),
    );
  });

  it("the new troubleshooting section has no over-claims and no banned phrases", () => {
    expectExact(
      [
        overclaims(troubleSection()),
        BANNED.filter((b) => norm(troubleSection()).includes(b)),
      ],
      [[], []],
      spec("troubleshooting over-claims"),
    );
  });
});
