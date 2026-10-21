import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Intent: the docs state the CURRENT fork version form (`<upstream base>-esc.<n>`)
 * and call `-pb` legacy. Marketplace/plugin names (cognigy-plugin-pb) and the
 * pb-crackers repo name are unrelated identities and are not asserted on here.
 */

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

const doc = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), ...parts), "utf8");

describe("MAINTAINING.md version form", () => {
  const text = doc("MAINTAINING.md");

  // Killing mutation: MAINTAINING.md still documents only the pb form.
  it("states the current form as <upstream base>-esc.<n>", () => {
    check(
      "MAINTAINING.md contains -esc.<n>",
      "The doc names the form new releases use",
      true,
      text.includes("-esc.<n>"),
      "Document the version form as `<upstream base>-esc.<n>`.",
    );
  });

  // Killing mutation: pb is mentioned but not flagged as legacy (or legacy is
  // said without naming -pb).
  it("says -pb is legacy on a line that names both", () => {
    check(
      "MAINTAINING.md has a line with both 'legacy' and '-pb'",
      "Maintainers must learn that pb versions are still valid but no longer generated",
      true,
      text.split("\n").some((l) => l.includes("legacy") && l.includes("-pb")),
      "Add a sentence such as: `-pb.<n>` versions are legacy; they stay valid but are never generated.",
    );
  });

  // Killing mutation: the old always-pb sentence is left in place.
  it("no longer says the fork's version is always <upstream base>-pb.<n>", () => {
    check(
      "MAINTAINING.md old always-pb sentence",
      "The old sentence is wrong now that releases use esc",
      false,
      text.includes("The fork's version is always `<upstream base>-pb.<n>`"),
      "Replace the sentence with the esc form and the legacy note.",
    );
  });
});

describe(".claude/CLAUDE.md version form", () => {
  const text = doc(".claude", "CLAUDE.md");

  // Killing mutation: the project rules still describe only pb.
  it("mentions the -esc.<n> form", () => {
    check(
      ".claude/CLAUDE.md contains -esc.<n>",
      "The project rules name the current version form",
      true,
      text.includes("-esc.<n>"),
      "Change `<x.y.z>-pb.<n>` / `<upstream base>-pb.<n>` to the -esc.<n> form.",
    );
  });

  // Killing mutation: the stale `<x.y.z>-pb.<n>` form is left behind.
  it("no longer presents <x.y.z>-pb.<n> as the form", () => {
    check(
      ".claude/CLAUDE.md contains <x.y.z>-pb.<n>",
      "The stale pb form must be gone",
      false,
      text.includes("<x.y.z>-pb.<n>"),
      "Rewrite it as `<x.y.z>-esc.<n>`.",
    );
  });
});

describe("README.md version form", () => {
  // Killing mutation: README presents -pb.<n> as the current form.
  it("does not present -pb.<n> as the current form", () => {
    check(
      "README.md contains -pb.<n>",
      "The README must not describe pb as the current version form",
      false,
      doc("README.md").includes("-pb.<n>"),
      "Use -esc.<n> wherever the form is described.",
    );
  });
});
