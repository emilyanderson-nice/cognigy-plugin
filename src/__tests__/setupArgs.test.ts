import { describe, it } from "@jest/globals";
import { stripSetupToken } from "../setup.js";
import { eq } from "./helpers/specAssert.js";

describe("stripSetupToken (change E)", () => {
  it.each<[string, string[], string[]]>([
    [
      "leading setup is removed",
      ["setup", "profile", "add", "setup"],
      ["profile", "add", "setup"],
    ],
    [
      "a value 'setup' later in argv is kept",
      ["profile", "add", "--api-key", "setup"],
      ["profile", "add", "--api-key", "setup"],
    ],
    ["empty argv", [], []],
    ["only setup", ["setup"], []],
    [
      "unrelated argv is unchanged",
      ["install", "--client", "codex"],
      ["install", "--client", "codex"],
    ],
    ["only ONE leading setup is removed", ["setup", "setup"], ["setup"]],
    [
      "setup as the profile name after a subcommand",
      ["profile", "show", "setup"],
      ["profile", "show", "setup"],
    ],
  ])("%s", (_label, input, expected) => {
    const copy = [...input];
    eq(
      stripSetupToken(input),
      expected,
      `stripSetupToken(${JSON.stringify(input)})`,
      "Change E: only a LEADING 'setup' token is dropped, once",
      "Remove the first token only when it equals 'setup'; keep every other token",
    );
    eq(
      input,
      copy,
      `stripSetupToken(${JSON.stringify(input)}) leaves its input intact`,
      "Change E: pure function",
      "Return a new array; do not mutate the argument",
    );
  });
});
