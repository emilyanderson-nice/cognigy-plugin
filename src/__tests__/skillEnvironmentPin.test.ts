/**
 * Guidance check: the environments skill tells the model to call
 * use_environment alone, in its own turn, before any other tool call (calls
 * issued in the same turn run in undefined order, so a pin could lose the race).
 *
 * The skill is read relative to process.cwd() (repo root under jest) and CRLF
 * is normalised to LF before matching.
 */
import { describe, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { ok, show } from "./helpers/specAssert.js";

const SKILL = "plugin/skills/environments/SKILL.md";

const text = fs
  .readFileSync(path.join(process.cwd(), SKILL), "utf8")
  .replace(/\r\n/g, "\n");

const sentences = (s: string): string[] =>
  s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

const matching = (): string[] =>
  sentences(text).filter(
    (s) => /use_environment/.test(s) && /alone/i.test(s) && /turn/i.test(s),
  );

describe("environments skill: use_environment ordering rule", () => {
  it("has a sentence with use_environment, alone and turn", () => {
    const hits = matching();
    ok(
      hits.length >= 1,
      "skillEnvironmentPin::sentence_present",
      "Rule: the pin call must be issued alone in its own turn, before other tools",
      "one sentence containing 'use_environment', 'alone' and 'turn'",
      "no such sentence",
      `Add the rule to ${SKILL} as a single sentence.`,
    );
    // Killing mutation: sentence absent, or its three terms split across sentences.
  });

  it("states the rule exactly once", () => {
    const hits = matching();
    ok(
      hits.length === 1,
      "skillEnvironmentPin::sentence_once",
      "Rule: state each rule once; no duplicate copies in the skill",
      "exactly 1 matching sentence",
      `${hits.length} matching sentences: ${show(hits)}`,
      "Keep a single statement of the rule; remove copies.",
    );
    // Killing mutation: the sentence pasted a second time (or absent: 0 hits).
  });

  it("keeps valid frontmatter with name and description", () => {
    const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
    ok(
      m !== null && /^name:/m.test(m[1]) && /^description:/m.test(m[1]),
      "skillEnvironmentPin::frontmatter",
      "Rule: editing the skill must not break its frontmatter",
      "file opens with '---', closes it, and has name: and description: keys",
      show(text.slice(0, 200)),
      "Insert the sentence in the body, below the closing '---'.",
    );
    // Killing mutation: sentence inserted above the opening '---' or inside it, or a key removed.
  });
});
