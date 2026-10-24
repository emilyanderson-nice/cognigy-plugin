import { describe, it } from "@jest/globals";
import { tools } from "../tools/definitions.js";
import { norm, readRepo, section } from "./helpers/docText.js";

const SKILL_PATH = "plugin/skills/flow-nodes/SKILL.md";
const skill = readRepo(SKILL_PATH);
const claudeMd = readRepo(".claude/CLAUDE.md");
const description = String(
  (tools.find((t) => t.name === "manage_flow_nodes") as any)?.description,
);

interface Failure {
  what: string;
  why: string;
  expected: string;
  actual: string;
  guidance: string;
}

/** Throws a 5-point message (what, why, expected, actual, guidance) when !ok. */
const assertThat = (ok: boolean, f: Failure): void => {
  if (ok) return;
  throw new Error(
    [
      `1. WHAT FAILED: ${f.what}`,
      `2. WHY: ${f.why}`,
      `3. EXPECTED: ${f.expected}`,
      `4. ACTUAL: ${f.actual}`,
      `5. GUIDANCE: ${f.guidance}`,
    ].join("\n"),
  );
};

const excerpt = (s: string): string => s.replace(/\s+/g, " ").slice(0, 300);

const goTo = section(skill, /^### goTo/);
const executeFlow = section(skill, /^### executeFlow/);
const goToRow = (field: string): string =>
  goTo.split(/\r?\n/).find((l) => l.startsWith(`| ${field} `)) ?? "";
const executeFlowNodeRow =
  executeFlow.split(/\r?\n/).find((l) => l.startsWith("| nodeId ")) ?? "";
const topNote =
  skill.split(/\r?\n/).find((l) => l.includes("Use `id` for API calls")) ?? "";
const chartBullet =
  claudeMd
    .split(/\r?\n/)
    .find((l) => l.includes("`GET /chart/nodes` returns no `config`")) ?? "";

// \bverified\b does not match "unverified".
const VERIFIED = /\bverified\b/;

describe("Go To / Execute Flow wording (C5)", () => {
  describe("SKILL.md goTo section", () => {
    it("section exists", () => {
      assertThat(goTo.length > 0, {
        what: "goTo section lookup",
        why: "the tests read from '### goTo' to the next '### ' heading",
        expected: "a non-empty section",
        actual: "empty",
        guidance: `keep the '### goTo' heading in ${SKILL_PATH}`,
      });
    });

    it.each(["flowNode", "continue", "referenceId"])("mentions %s", (word) => {
      assertThat(goTo.includes(word), {
        what: `goTo section mentions ${word}`,
        why: "the corrected Go To config is flowNode { flow, node } (both referenceIds) with executionMode continue",
        expected: `the goTo section contains "${word}"`,
        actual: excerpt(goTo),
        guidance: `document ${word} in the goTo config table`,
      });
    });

    it("says the target is verified (not only unverified)", () => {
      assertThat(VERIFIED.test(goTo), {
        what: "goTo section states 'verified'",
        why: "Go To referenceId targeting was verified live on NA1 (C5 evidence)",
        expected: "the word 'verified' (as in 'verified on NA1')",
        actual: excerpt(goTo),
        guidance:
          "replace 'Reported (NA1, unverified)' for goTo with 'verified on NA1'",
      });
    });

    it("flowNode row says both flow and node are referenceIds and verified", () => {
      const row = goToRow("flowNode");
      assertThat(row !== "" && /referenceId/.test(row) && VERIFIED.test(row), {
        what: "goTo flowNode table row",
        why: "flowNode { flow, node } takes referenceIds and was verified for a jump inside one flow",
        expected: "a '| flowNode ' row containing 'referenceId' and 'verified'",
        actual: row === "" ? "no '| flowNode ' row" : excerpt(row),
        guidance: "add a flowNode row to the goTo config table",
      });
    });

    it("no longer contains goAndDontReturn", () => {
      assertThat(!goTo.includes("goAndDontReturn"), {
        what: "goAndDontReturn removed from goTo",
        why: "no evidence supports that executionMode value",
        expected: "no 'goAndDontReturn' in the goTo section",
        actual: excerpt(goToRow("executionMode")),
        guidance: "remove it from the executionMode row",
      });
    });

    it("executionMode row offers continue and wait but not execute", () => {
      const row = goToRow("executionMode");
      assertThat(row !== "", {
        what: "goTo executionMode row exists",
        why: "executionMode is documented in the goTo table",
        expected: "a '| executionMode ' row",
        actual: "missing",
        guidance: "keep the executionMode row",
      });
      assertThat(!/`execute`/.test(row), {
        what: "executionMode row does not offer `execute`",
        why: "`execute` is not supported by any evidence",
        expected: "values continue and wait only",
        actual: excerpt(row),
        guidance: "replace `execute` (default) with `continue` / `wait`",
      });
      assertThat(/`continue`/.test(row) && /`wait`/.test(row), {
        what: "executionMode row offers continue and wait",
        why: "continue is verified; wait is inferred from the UI wording",
        expected: "both `continue` and `wait` in the row",
        actual: excerpt(row),
        guidance: "document `continue` (verified on NA1) and `wait` (inferred)",
      });
      assertThat(/`continue`[^|]*verified on NA1/i.test(row), {
        what: "continue is marked verified on NA1",
        why: "the live check observed executionMode continue jumping correctly",
        expected: "'`continue` ... verified on NA1' in the row",
        actual: excerpt(row),
        guidance: "state 'verified on NA1' next to `continue`",
      });
      assertThat(!/default/i.test(row), {
        what: "no default claim for executionMode",
        why: "the default is not evidenced",
        expected: "no 'default' in the row",
        actual: excerpt(row),
        guidance: "remove the default claim",
      });
    });
  });

  describe("SKILL.md executeFlow section", () => {
    it("still labels the nodeId referenceId rule 'Reported (NA1, unverified)'", () => {
      assertThat(executeFlowNodeRow.includes("Reported (NA1, unverified)"), {
        what: "executeFlow nodeId row label",
        why: "Execute Flow was not tested, so its rule stays reported",
        expected: "'Reported (NA1, unverified)' in the executeFlow nodeId row",
        actual: excerpt(executeFlowNodeRow) || "no '| nodeId ' row",
        guidance: "do not upgrade the executeFlow wording",
      });
    });
  });

  describe("SKILL.md near-top note", () => {
    it("says goTo is verified and executeFlow reported", () => {
      const t = norm(topNote);
      assertThat(
        topNote !== "" &&
          /go\s?to[^.;]*\bverified\b/.test(t) &&
          /execute\s?flow[^.;]*\breported\b/.test(t),
        {
          what: "id vs referenceId note",
          why: "goTo targeting is verified on NA1; executeFlow is only reported",
          expected:
            "the 'Use `id` for API calls' line says goTo ... verified and executeFlow ... reported",
          actual: excerpt(topNote) || "line not found",
          guidance:
            "reword: goTo targets use referenceId (verified on NA1); executeFlow reported, not verified",
        },
      );
    });
  });

  describe("manage_flow_nodes tool description", () => {
    const d = norm(description);

    it("says Go To uses referenceId and is verified", () => {
      assertThat(
        /go to[^.]{0,200}referenceid[^.]{0,200}\bverified\b/.test(d) ||
          /go to[^.]{0,200}\bverified\b[^.]{0,200}referenceid/.test(d),
        {
          what: "description: Go To referenceId verified",
          why: "the live NA1 check verified it",
          expected: "a sentence with 'Go To', 'referenceId' and 'verified'",
          actual: excerpt(description),
          guidance:
            "write 'Go To targets a node by referenceId (verified on NA1)'",
        },
      );
    });

    it("still labels Execute Flow as reported", () => {
      assertThat(/execute flow[^.]{0,200}\breported\b/.test(d), {
        what: "description: Execute Flow reported",
        why: "Execute Flow was not tested",
        expected: "a sentence with 'Execute Flow' and 'reported'",
        actual: excerpt(description),
        guidance: "keep 'Execute Flow reported, not verified'",
      });
    });
  });

  describe(".claude/CLAUDE.md flow-chart bullet", () => {
    const t = norm(chartBullet);
    const tail = t.slice(Math.max(0, t.indexOf("go to")));

    it("bullet exists", () => {
      assertThat(chartBullet !== "", {
        what: "flow-chart bullet lookup",
        why: "the bullet starting with the GET /chart/nodes gotcha carries the Go To claim",
        expected: "a line containing '`GET /chart/nodes` returns no `config`'",
        actual: "not found",
        guidance: "keep that bullet in .claude/CLAUDE.md",
      });
    });

    it("says Go To targets referenceId, verified", () => {
      assertThat(
        /go to[^.]{0,200}referenceid[^.]{0,200}\bverified\b/.test(tail),
        {
          what: "CLAUDE.md bullet: Go To verified",
          why: "the live NA1 check verified it",
          expected: "'Go To ... referenceId ... verified'",
          actual: excerpt(tail),
          guidance:
            "write 'Go To targets a node by referenceId (verified on NA1)'",
        },
      );
    });

    it("says Execute Flow reported, not verified", () => {
      assertThat(/execute flow[^.]{0,200}\breported\b/.test(tail), {
        what: "CLAUDE.md bullet: Execute Flow reported",
        why: "Execute Flow was not tested",
        expected: "'Execute Flow ... reported'",
        actual: excerpt(tail),
        guidance: "keep 'Execute Flow reported, not verified'",
      });
    });
  });
});
