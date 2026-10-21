/**
 * The repo's commitlint config must skip upstream squash commits (subjects
 * ending in " (#<digits>)", which cannot be rewritten) while still linting
 * everything else, including over-long headers without that suffix.
 */
import path from "path";
import { fileURLToPath } from "url";

import { describe, it, expect, beforeAll } from "@jest/globals";
import load from "@commitlint/load";
import lint from "@commitlint/lint";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

type LintOutcome = Awaited<ReturnType<typeof lint>>;

let config: Awaited<ReturnType<typeof load>>;

beforeAll(async () => {
  config = await load({}, { cwd: repoRoot });
});

const lintMessage = (message: string): Promise<LintOutcome> =>
  lint(message, config.rules, {
    parserOpts: config.parserPreset?.parserOpts,
    ignores: config.ignores,
    defaultIgnores: config.defaultIgnores,
  });

const ruleNames = (outcome: LintOutcome): string[] =>
  outcome.errors.map((e) => e.name);

const UPSTREAM_SUBJECT =
  "fix(flow-nodes): support Copilot wait/status nodes, wrap adaptive cards, flag duplicate imports (#57)";

/** A conventional header of exactly `length` characters, no PR suffix. */
const headerOfLength = (length: number): string => {
  const prefix = "fix(flow-nodes): ";
  return prefix + "x".repeat(length - prefix.length);
};

describe("commitlint config: upstream squash subjects", () => {
  it("C1 accepts the 101-character upstream subject ending in ' (#57)'", async () => {
    // Killing mutation: remove the ignore (or make it not match the suffix) -> header-max-length error.
    expect(UPSTREAM_SUBJECT).toHaveLength(101);
    const outcome = await lintMessage(UPSTREAM_SUBJECT);
    expect(outcome.errors).toEqual([]);
    expect(outcome.valid).toBe(true);
  });

  it("C2 rejects a 101-character header without the suffix on header-max-length", async () => {
    // Killing mutation: ignore every over-long header, or drop header-max-length.
    const header = headerOfLength(101);
    expect(header).toHaveLength(101);
    expect(ruleNames(await lintMessage(header))).toEqual(["header-max-length"]);
  });

  it.each([
    ["' (see #57)'", " (see #57)"],
    ["' (#57x)'", " (#57x)"],
    ["'(#57)' without a space", "(#57)"],
    ["' (#)' without digits", " (#)"],
    ["' (#57) ' with trailing text", " (#57) more"],
  ])(
    "C3 still rejects a 101-character header ending in %s",
    async (_label, suffix) => {
      // Killing mutation: loosen the ignore regex (drop the single space, the digits, or the end anchor).
      const header = headerOfLength(101 - suffix.length) + suffix;
      expect(header).toHaveLength(101);
      expect(ruleNames(await lintMessage(header))).toContain(
        "header-max-length",
      );
    },
  );

  it("C6 applies the ignore to the subject only, not to body lines", async () => {
    // Killing mutation: match the suffix anywhere in the message (multiline flag / no subject anchoring).
    const header = headerOfLength(101);
    const message = `${header}\n\nWHY:\n- reference to upstream change (#57)\n`;
    expect(ruleNames(await lintMessage(message))).toContain(
      "header-max-length",
    );
  });
});

describe("commitlint config: regular rules stay active", () => {
  it("C4 accepts a short conventional header with a WHY/EXPECTED body", async () => {
    // Killing mutation: an ignore so broad it matches everything would still pass this, so C2/C3/C4b/C4c cover that.
    const message =
      "fix(config): reject blank environment names\n\nWHY:\n- blank names silently resolved to the default\n\nEXPECTED:\n- a clear error is returned\n";
    const outcome = await lintMessage(message);
    expect(outcome.errors).toEqual([]);
    expect(outcome.valid).toBe(true);
  });

  it("C4 rejects a 201-character body line on body-max-line-length", async () => {
    // Killing mutation: remove the body-max-line-length override or ignore bodies.
    const longLine = "y".repeat(201);
    const outcome = await lintMessage(
      `fix(config): short header\n\n${longLine}\n`,
    );
    expect(ruleNames(outcome)).toEqual(["body-max-line-length"]);
  });

  it("C4 accepts a 200-character body line", async () => {
    // Killing mutation: tighten the body limit below 200.
    const outcome = await lintMessage(
      `fix(config): short header\n\n${"y".repeat(200)}\n`,
    );
    expect(outcome.errors).toEqual([]);
  });

  it("C4 rejects a non-conventional type", async () => {
    // Killing mutation: drop the conventional-commits extends / type-enum.
    expect(ruleNames(await lintMessage("wip: something"))).toContain(
      "type-enum",
    );
  });
});

describe("commitlint config: merge commits stay ignored", () => {
  it.each([
    "Merge pull request #5 from emilyanderson-nice/feature/x",
    "Merge pb-crackers/main (1.22.1-pb.5) into fork (1.22.1-esc.1)",
  ])("C5 ignores %s", async (message) => {
    // Killing mutation: replace defaultIgnores with a custom ignore list that omits merge commits.
    const outcome = await lintMessage(message);
    expect(outcome.errors).toEqual([]);
    expect(outcome.valid).toBe(true);
  });
});
