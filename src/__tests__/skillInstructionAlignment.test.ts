/**
 * Guidance check: an agent's instructions and its tools' descriptions must
 * agree. The rule lives in ONE skill section (agent-creation); the other
 * skills/agent carry one-line pointers, never copies.
 *
 * All files are read relative to process.cwd() (the repo root under jest) and
 * CRLF is normalised to LF before matching.
 */
import { describe, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { ok, show } from "./helpers/specAssert.js";

const HEADING = "Check that the agent and its tools agree";
const SECTION_RULE = "State each rule once";

const AGENT_CREATION = "plugin/skills/agent-creation/SKILL.md";
const KNOWLEDGE = "plugin/skills/knowledge-setup/SKILL.md";
const TOOLS = "plugin/skills/tools-setup/SKILL.md";
const TROUBLESHOOTING = "plugin/skills/troubleshooting/SKILL.md";
const BUILDER = "plugin/agents/cognigy-agent-builder.md";
const POINTER_FILES = [KNOWLEDGE, TOOLS, TROUBLESHOOTING, BUILDER];

function read(rel: string): string {
  return fs
    .readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/\r\n/g, "\n");
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

function headings(text: string): Heading[] {
  const out: Heading[] = [];
  text.split("\n").forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

/** Body of the section starting at `h`, up to the next heading of same or higher level. */
function sectionBody(text: string, hs: Heading[], h: Heading): string {
  const lines = text.split("\n");
  const next = hs.find((x) => x.line > h.line && x.level <= h.level);
  return lines.slice(h.line, next ? next.line : lines.length).join("\n");
}

const paragraphs = (text: string): string[] =>
  text.split(/\n\s*\n/).map((p) => p.trim());

function alignmentHeadings(text: string): Heading[] {
  return headings(text).filter(
    (h) => h.text === HEADING && (h.level === 2 || h.level === 3),
  );
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : listFiles(p);
    return [p];
  });
}

describe("S1 agent-creation holds the single alignment section", () => {
  it("has exactly one level-2/3 heading with the exact text", () => {
    const hits = alignmentHeadings(read(AGENT_CREATION));
    ok(
      hits.length === 1,
      "alignment::single_heading",
      "Rule: the agent/tool alignment check is defined once, as a ## or ### heading in agent-creation",
      `exactly 1 heading '${HEADING}'`,
      `${hits.length} headings found`,
      "Add one section with exactly this heading to agent-creation/SKILL.md.",
    );
    // Killing mutation: heading missing, duplicated, renamed, or demoted to #### / bold text.
  });

  const body = (): string => {
    const t = read(AGENT_CREATION);
    const hs = headings(t);
    const h = alignmentHeadings(t)[0];
    return h ? sectionBody(t, hs, h) : "";
  };

  it.each([
    ["instructions", /instructions/],
    ["jobDescription", /jobDescription/],
    ["jobInstructions", /jobInstructions/],
    ["authorization", /authoriz/i],
    ["escalation", /escalat/i],
    ["talk_to_agent", /talk_to_agent/],
    ["once-rule wording", /\bonce\b/i],
    ["State each rule once", /State each rule once/i],
    ["tool description", /tool'?s? description|tool's description/i],
  ])("section body mentions %s", (name, re) => {
    const b = body();
    ok(
      b !== "" && re.test(b),
      `alignment::section_mentions_${name}`,
      "Rule: the section teaches comparing agent instructions with tool descriptions on authorization/escalation and verifying via talk_to_agent",
      `section body matching ${String(re)}`,
      b === "" ? "section missing" : show(b.slice(0, 400)),
      `Mention ${name} inside the '${HEADING}' section body.`,
    );
    // Killing mutation: remove that word from the section body (or move it to a different section).
  });

  it("sits after 'How the fields work together' and before the LLM Prompt node section", () => {
    const t = read(AGENT_CREATION);
    const hs = headings(t);
    const h = alignmentHeadings(t)[0];
    const how = hs.find((x) => x.text === "How the fields work together");
    const llm = hs.find((x) => /^LLM Prompt node/.test(x.text));
    ok(
      !!h && !!how && !!llm && how.line < h.line && h.line < llm.line,
      "alignment::section_position",
      "Rule: the check sits with the instruction-field guidance",
      "line(How the fields work together) < line(alignment heading) < line(LLM Prompt node)",
      show({ how: how?.line, alignment: h?.line, llm: llm?.line }),
      "Place the section between 'How the fields work together' and 'LLM Prompt node'.",
    );
    // Killing mutation: place the section at the end of the file or before 'How the fields work together'.
  });
});

describe("S2 pointers, not copies", () => {
  it.each(POINTER_FILES)(
    "%s points at the heading and agent-creation in one paragraph",
    (file) => {
      const hit = paragraphs(read(file)).find(
        (p) => p.includes(HEADING) && p.includes("agent-creation"),
      );
      ok(
        hit !== undefined,
        `alignment::pointer::${file}`,
        "Rule: other skills point to the single source of truth",
        `a paragraph containing '${HEADING}' and 'agent-creation'`,
        "no such paragraph",
        "Add a one-line pointer naming the agent-creation skill and the section heading.",
      );
      // Killing mutation: omit the pointer, omit the skill name, or split them into separate paragraphs.
    },
  );

  it.each(POINTER_FILES)(
    "%s does not copy the instructional sentence",
    (file) => {
      ok(
        !/State each rule once/i.test(read(file)),
        `alignment::no_copy::${file}`,
        "Rule: DRY, the rule text lives only in agent-creation",
        `no '${SECTION_RULE}' in ${file}`,
        "sentence present",
        "Replace the copied text with a pointer.",
      );
      // Killing mutation: paste the section's sentence into a pointer file.
    },
  );

  it("knowledge-setup pointer comes after Steps and the 'Attach to agent as a TOOL' line", () => {
    const t = read(KNOWLEDGE);
    const lines = t.split("\n");
    const steps = headings(t).find((h) => h.text === "Steps");
    const attach = lines.findIndex((l) =>
      l.includes("Attach to agent as a TOOL"),
    );
    const pointer = lines.findIndex(
      (l, i) => i > attach && attach >= 0 && l.includes(HEADING),
    );
    // The pointer may be in the same paragraph as the heading text on a later line;
    // find the first line mentioning the heading at all for the position check.
    const firstMention = lines.findIndex((l) => l.includes(HEADING));
    ok(
      !!steps &&
        attach >= 0 &&
        firstMention >= 0 &&
        steps.line < attach &&
        attach < firstMention &&
        pointer >= 0,
      "alignment::knowledge_pointer_position",
      "Rule: the pointer sits where knowledge is attached as a tool (where the conflict arises)",
      "line(Steps) < line(Attach to agent as a TOOL) < line(pointer)",
      show({ steps: steps?.line, attach, firstMention, pointer }),
      "Put the pointer right after the 'Attach to agent as a TOOL' step.",
    );
    // Killing mutation: put the pointer in Prerequisites/Tips above the attach step.
  });
});

describe("S3 troubleshooting names the symptom", () => {
  it("a paragraph combines 'no knowledge', escalate, authorize and the heading", () => {
    const hit = paragraphs(read(TROUBLESHOOTING)).find((p) => {
      const l = p.toLowerCase();
      return (
        l.includes("no knowledge") &&
        l.includes("escalate") &&
        l.includes("authorize") &&
        p.includes(HEADING)
      );
    });
    ok(
      hit !== undefined,
      "alignment::troubleshooting_symptom",
      "Rule: the symptoms (says it has no knowledge, offers to escalate, tries to authorize first) lead to the alignment check",
      "one paragraph with 'no knowledge', 'escalate', 'authorize' and the alignment heading",
      "no such paragraph",
      "Describe the symptom in plain words and point at the alignment check in the same paragraph.",
    );
    // Killing mutation: drop any one of the three symptom words or the pointer heading from that paragraph.
  });
});

describe("S4 frontmatter intact", () => {
  it.each(POINTER_FILES.concat(AGENT_CREATION))(
    "%s still starts with name/description frontmatter",
    (file) => {
      const t = read(file);
      const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
      ok(
        !!m && /^name:/m.test(m[1]) && /^description:/m.test(m[1]),
        `alignment::frontmatter::${file}`,
        "Rule: edits must not damage frontmatter",
        "file starts with --- block containing name: and description:",
        show(t.slice(0, 200)),
        "Restore the frontmatter block at the top of the file.",
      );
      // Killing mutation: text inserted above ---, or name:/description: deleted.
    },
  );
});

describe("S6 count guard", () => {
  it("the heading text appears in exactly the five expected plugin files", () => {
    const withHeading = listFiles(path.join(process.cwd(), "plugin"))
      .filter((f) => fs.readFileSync(f, "utf8").includes(HEADING))
      .map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"))
      .sort();
    const expected = [AGENT_CREATION, ...POINTER_FILES].sort();
    ok(
      JSON.stringify(withHeading) === JSON.stringify(expected),
      "alignment::count_guard",
      "Rule: the heading text exists only in the source section and four pointers",
      show(expected),
      show(withHeading),
      "Remove copies from other plugin files; add missing pointers.",
    );
    // Killing mutation: a sixth file copies the heading, or one pointer/heading is missing.
  });
});
