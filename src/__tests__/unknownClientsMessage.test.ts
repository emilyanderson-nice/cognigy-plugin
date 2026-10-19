import { describe, it, expect } from "@jest/globals";
import * as setupModule from "../setup.js";

// Namespace import so a missing unknownClientsMessage export fails each test
// individually instead of aborting the suite at link time.
const VALID =
  "Valid values: claude-code, claude-desktop, codex, antigravity, other-hosts.\n";
const GEMINI_HINT =
  "  Gemini CLI support was removed: https://github.com/emilyanderson-nice/cognigy-plugin/blob/main/docs/install/gemini-cli.md\n" +
  "  Remove an installed extension with: gemini extensions uninstall cognigy\n";

function unknownClientsMessage(invalid: string[]): string {
  const fn = (
    setupModule as unknown as {
      unknownClientsMessage?: (invalid: string[]) => string;
    }
  ).unknownClientsMessage;
  if (typeof fn !== "function") {
    throw new Error(
      "setup.ts does not export unknownClientsMessage(invalid: string[]): string",
    );
  }
  return fn(invalid);
}

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: () => unknown,
  guidance: string,
  mode: "equal" | "contains" = "equal",
): void {
  let value: unknown;
  try {
    value = actual();
    if (mode === "contains") {
      expect(String(value)).toContain(String(expected));
    } else {
      expect(value).toEqual(expected);
    }
  } catch (e) {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED${mode === "contains" ? " (substring)" : ""}: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${value === undefined ? `threw: ${(e as Error).message.split("\n")[0]}` : JSON.stringify(value)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

describe("unknownClientsMessage", () => {
  it("reports a single unknown client with the valid list and trailing newline", () => {
    check(
      "single unknown client",
      "an unknown --client value is named and the valid values listed",
      `Unknown --client value(s): foo. ${VALID}`,
      () => unknownClientsMessage(["foo"]),
      "Export a pure function from setup.ts returning the exact text, newline-terminated.",
    );
  });

  it("joins several unknown clients with comma and space, in input order", () => {
    check(
      "multiple unknown clients",
      "all invalid values are listed in the order given",
      `Unknown --client value(s): foo, bar. ${VALID}`,
      () => unknownClientsMessage(["foo", "bar"]),
      "Join the invalid array with ', ' without sorting or de-duplicating.",
    );
  });

  it("adds the Gemini removal hint, with the real repository URL, for gemini", () => {
    check(
      "gemini hint",
      "the retired gemini client gets a removal hint with a resolved URL",
      `Unknown --client value(s): gemini. ${VALID}${GEMINI_HINT}`,
      () => unknownClientsMessage(["gemini"]),
      "Append the two indented hint lines after the valid list; interpolate the repo URL (template literal).",
    );
  });

  it("adds the Gemini hint when gemini is mixed with another unknown value", () => {
    const run = () => unknownClientsMessage(["foo", "gemini"]);
    check(
      "mixed foo and gemini: header",
      "both unknown values are named",
      `Unknown --client value(s): foo, gemini. ${VALID}`,
      run,
      "Header lists every invalid value joined by ', '.",
      "contains",
    );
    check(
      "mixed foo and gemini: hint",
      "the gemini hint appears exactly as for gemini alone",
      GEMINI_HINT,
      run,
      "Add the hint whenever the invalid list includes gemini.",
      "contains",
    );
    check(
      "mixed foo and gemini: hint appears once",
      "the hint is not repeated",
      1,
      () => run().split("Gemini CLI support was removed").length - 1,
      "Emit the hint a single time.",
    );
  });

  it("does not add the Gemini hint when gemini is not among the values", () => {
    check(
      "no gemini hint for foo",
      "the hint is only for gemini",
      false,
      () => unknownClientsMessage(["foo", "bar"]).includes("gemini"),
      "Gate the hint on the invalid list containing exactly 'gemini'.",
    );
  });

  it("never leaks an uninterpolated template placeholder", () => {
    for (const input of [
      ["foo"],
      ["foo", "bar"],
      ["gemini"],
      ["foo", "gemini"],
    ]) {
      const label = JSON.stringify(input);
      check(
        `no literal interpolation for ${label}`,
        "output contains no literal '${'",
        false,
        () => unknownClientsMessage(input).includes("${"),
        "Use a template literal (backticks) wherever ${...} is used.",
      );
      check(
        `no FORK_REPO name for ${label}`,
        "output contains no FORK_REPO identifier text",
        false,
        () => unknownClientsMessage(input).includes("FORK_REPO"),
        "Interpolate the constant's value instead of writing its name in a plain string.",
      );
    }
  });

  it("reports an empty --client value as (empty)", () => {
    check(
      "empty client label",
      "an empty --client value is shown as (empty)",
      `Unknown --client value(s): (empty). ${VALID}`,
      () => unknownClientsMessage(["(empty)"]),
      "Pass the '(empty)' label through unchanged; no hint is added.",
    );
  });
});
