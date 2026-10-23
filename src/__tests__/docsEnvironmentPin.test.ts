import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Docs must describe the session pin (`use_environment`, COGNIGY_ENVIRONMENT,
 * COGNIGY_DEFAULT_PROFILE): with a pin, `environment` may be omitted. The Claude
 * plugin's two user settings are optional, and the documented merge-resolver
 * command must be runnable while package.json is conflicted.
 */

const ROOT = process.cwd();

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

const read = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Text from the heading line matching `start` to the next heading of `level` (or shallower). */
function section(text: string, start: string, level: number): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === start);
  if (i < 0) return "";
  let end = lines.length;
  let inFence = false;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*```/.test(lines[j])) inFence = !inFence;
    const h = inFence ? null : lines[j].match(/^(#{1,6})\s/);
    if (h && h[1].length <= level) {
      end = j;
      break;
    }
  }
  return lines.slice(i, end).join("\n");
}

const sentences = (text: string): string[] => text.split(". ");

describe("README: the environment rule carries the pin exception", () => {
  const readme = read("README.md");

  it("the sentence saying environment is required on every call mentions the pin", () => {
    const hits = sentences(readme).filter((s) =>
      /required\*{0,2} on every call/.test(s),
    );
    check(
      "README required-on-every-call sentence names the pin",
      "With a pinned session `environment` may be omitted, so the rule sentence must say so",
      { found: true, mentionsPin: true },
      {
        found: hits.length > 0,
        mentionsPin: hits.length > 0 && hits.every((s) => /pin/i.test(s)),
      },
      "Reword the sentence to say `environment` is required on every call unless the session is pinned (use_environment, COGNIGY_ENVIRONMENT, Default Cognigy profile).",
    );
  });

  it("does not claim the tool schemas mark environment required", () => {
    check(
      "README schema-required claim",
      "The dispatcher never marks `environment` required in any schema",
      false,
      readme.includes("the tool schemas mark it required"),
      "Delete the clause `the tool schemas mark it required` (the registry enforces it, not the schema).",
    );
  });

  it("the multiple-environments section mentions use_environment", () => {
    const body = section(readme, "### Add another environment", 2);
    check(
      "README Add another environment section mentions use_environment",
      "Users adding environments must learn how to pin a session",
      { sectionFound: true, mentions: true },
      { sectionFound: body !== "", mentions: body.includes("use_environment") },
      "Mention `use_environment` in the section starting at `### Add another environment`.",
    );
  });
});

describe(".claude/CLAUDE.md: Environments section covers the pin", () => {
  const body = section(
    read(".claude/CLAUDE.md"),
    "## Environments (multi-profile routing)",
    2,
  );

  it("mentions the pin tool, both settings and both source files", () => {
    const terms = [
      "use_environment",
      "COGNIGY_ENVIRONMENT",
      "COGNIGY_DEFAULT_PROFILE",
      "sessionPin.ts",
      "sessionState.ts",
    ];
    check(
      "CLAUDE.md Environments section pin vocabulary",
      "The architecture notes must name the pin mechanism and where it lives",
      Object.fromEntries(terms.map((t) => [t, true])),
      Object.fromEntries(terms.map((t) => [t, body.includes(t)])),
      "Add a bullet describing the session pin to the Environments section naming each missing term.",
    );
  });

  it("the 'never falls back to a default' sentence states the pin exception", () => {
    const hits = sentences(body).filter((s) =>
      s.includes("never falls back to a default"),
    );
    check(
      "CLAUDE.md never-falls-back sentence names the pin",
      "A pinned session is the one case where `environment` may be omitted",
      { found: true, mentionsPin: true },
      {
        found: hits.length > 0,
        mentionsPin: hits.length > 0 && hits.every((s) => /pin/i.test(s)),
      },
      "Qualify the sentence: required with two or more environments unless the session is pinned.",
    );
  });
});

describe("Claude Code install: plugin settings are optional", () => {
  const doc = read("docs/install/claude-code.md");

  it("docs/install/claude-code.md no longer says the server will not start without both settings", () => {
    check(
      "claude-code.md stale required-settings claims",
      "The URL and key settings are optional; the server starts without them",
      { notStart: false, asRequired: false },
      {
        notStart: doc.includes("does not start the server until both are set"),
        asRequired: doc.includes("as required settings"),
      },
      "Rewrite the sentence at docs/install/claude-code.md:35 to describe the settings as optional.",
    );
  });

  it("docs/install/claude-code.md says optional, and that blank uses saved profiles or the credentials file", () => {
    check(
      "claude-code.md optional/blank wording",
      "Users must learn leaving the settings blank falls back to saved profiles or the credentials file",
      { optional: true, blank: true },
      { optional: doc.includes("optional"), blank: doc.includes("blank") },
      "State that the two settings are optional and that leaving them blank uses saved profiles or the credentials file.",
    );
  });

  it("src/install/claudeCode.ts comment no longer calls the userConfig options required", () => {
    check(
      "claudeCode.ts stale 'are required' comment",
      "The comment must not say the manifest's userConfig options are required",
      false,
      read("src/install/claudeCode.ts").includes(
        "userConfig options are required",
      ),
      "Reword the comment at src/install/claudeCode.ts:49 (the options are optional; --config still stores the key in the credential store).",
    );
  });
});

describe("MAINTAINING.md: upstream-merge resolver step is runnable mid-merge", () => {
  const body = section(
    read("MAINTAINING.md"),
    "## Taking updates from upstream",
    2,
  );

  it("names the direct script command node scripts/resolve-upstream-merge.mjs", () => {
    check(
      "MAINTAINING.md direct resolver command",
      "While package.json is conflicted npm cannot start, so the script is run with node",
      true,
      body.includes("node scripts/resolve-upstream-merge.mjs"),
      "Use `node scripts/resolve-upstream-merge.mjs` as the resolver step in the merge procedure.",
    );
  });

  it("explains why (EJSONPARSE / cannot parse)", () => {
    check(
      "MAINTAINING.md explains npm failure",
      "Readers must know why `npm run merge:resolve` cannot be used mid-merge",
      true,
      body.includes("EJSONPARSE") || body.includes("cannot parse"),
      "Add a sentence: npm exits with EJSONPARSE because the conflicted package.json cannot be parsed.",
    );
  });

  it("no fenced block has a bare `npm run merge:resolve` line without the direct command", () => {
    const blocks = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    const bad = blocks.filter(
      (b) =>
        /^\s*npm run merge:resolve\b/m.test(b) &&
        !b.includes("node scripts/resolve-upstream-merge.mjs"),
    );
    check(
      "MAINTAINING.md bare npm run merge:resolve in a code block",
      "A fenced block must not offer `npm run merge:resolve` as the mid-merge step without the direct script command",
      [],
      bad,
      "Replace the line with `node scripts/resolve-upstream-merge.mjs` in the fenced block.",
    );
  });
});
