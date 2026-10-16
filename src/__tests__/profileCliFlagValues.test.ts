import { describe, it } from "@jest/globals";
import {
  KEY,
  makeHarness,
  mkProfile,
  mkSet,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq } from "./helpers/specAssert.js";

const ENV = { CGKEY: KEY } as NodeJS.ProcessEnv;
const VALUE_FLAGS = [
  "--api-base-url",
  "--api-key-env",
  "--api-key",
  "--endpoint-base-url",
  "--webchat-base-url",
  "--static-files-base-url",
  "--version-hint",
];
const GOOD: Record<string, string> = {
  "--api-base-url": "https://api-x.cognigy.ai",
  "--api-key-env": "CGKEY",
  "--endpoint-base-url": "https://endpoint-x.cognigy.ai",
  "--webchat-base-url": "https://webchat-x.cognigy.ai",
  "--static-files-base-url": "https://static-x.cognigy.ai",
  "--version-hint": "2026.21",
};
/** Valid add args, omitting `skip`. */
function goodArgs(skip?: string): string[] {
  return Object.entries(GOOD)
    .filter(([f]) => f !== skip)
    .flatMap(([f, v]) => [f, v]);
}
const effects = (h: ReturnType<typeof makeHarness>): number[] => [
  h.upserts.length,
  h.defaults.length,
  h.removes.length,
  h.gets.length,
];

describe("value flags reject a following --token (change D)", () => {
  it.each(VALUE_FLAGS)(
    "add x %s --default: exit 1 naming the flag, no write, value not quoted",
    async (flag) => {
      const h = makeHarness({ env: ENV });
      await runExpect(
        h,
        ["add", "x", ...goodArgs(flag), flag, "--default", "--no-test"],
        1,
        `profile add x ${flag} --default exits 1`,
        "Change D: a value flag followed by a --token has no value",
        "Do not swallow the next flag as the value",
      );
      mustContain(
        h.errText(),
        [flag],
        `profile add x ${flag} --default message`,
        "Change D: message names the flag",
        "Name the flag",
      );
      mustNotContain(
        h.errText(),
        ["--default"],
        `profile add x ${flag} --default message hides the value`,
        "Change D: never quotes the value",
        "Do not echo the offending token",
      );
      eq(
        effects(h),
        [0, 0, 0, 0],
        `profile add x ${flag} --default effects`,
        "Change D: no write",
        "Reject before acting",
      );
    },
  );

  it("add x --api-base-url --no-test: fails, no write", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", "x", "--api-key-env", "CGKEY", "--api-base-url", "--no-test"],
      1,
      "profile add x --api-base-url --no-test exits 1",
      "Change D",
      "Reject",
    );
    eq(
      effects(h),
      [0, 0, 0, 0],
      "profile add x --api-base-url --no-test effects",
      "Change D: no write",
      "Reject before acting",
    );
  });

  it("--flag=--something stays allowed and is stored verbatim", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      [
        "add",
        "x",
        ...goodArgs("--version-hint"),
        "--version-hint=--weird",
        "--no-test",
      ],
      0,
      "profile add x --version-hint=--weird exits 0",
      "Change D: the = form may carry a value starting with --",
      "Accept the = form",
    );
    eq(
      h.upserts[0]?.profile.versionHint,
      "--weird",
      "profile add --version-hint=--weird stored",
      "Change D",
      "Store the value",
    );
  });
});

describe("any flag given more than once is rejected (change D)", () => {
  it.each(VALUE_FLAGS)(
    "add: %s twice (spaced and = forms) exits 1 'given more than once'",
    async (flag) => {
      const h = makeHarness({ env: ENV });
      const value = GOOD[flag] ?? "https://other.test";
      await runExpect(
        h,
        [
          "add",
          "x",
          ...goodArgs(flag),
          flag,
          value,
          `${flag}=${value}`,
          "--no-test",
        ],
        1,
        `profile add x ${flag} twice exits 1`,
        "Change D: duplicates are rejected",
        "Reject repeated flags",
      );
      mustContain(
        h.errText(),
        [flag, "given more than once"],
        `profile add x ${flag} twice message`,
        "Change D: names the flag and says 'given more than once'",
        "Name the repeated flag",
      );
      eq(
        effects(h),
        [0, 0, 0, 0],
        `profile add x ${flag} twice effects`,
        "Change D: no write",
        "Reject before acting",
      );
    },
  );

  it.each([
    [
      "add --default",
      ["add", "x", ...goodArgs(), "--default", "--default", "--no-test"],
      "--default",
    ],
    [
      "add --force",
      ["add", "x", ...goodArgs(), "--force", "--force", "--no-test"],
      "--force",
    ],
    [
      "add --no-test",
      ["add", "x", ...goodArgs(), "--no-test", "--no-test"],
      "--no-test",
    ],
    ["list --json", ["list", "--json", "--json"], "--json"],
    ["remove --yes", ["remove", "dev", "--yes", "--yes"], "--yes"],
    ["test --all", ["test", "--all", "--all"], "--all"],
    ["default --clear", ["default", "--clear", "--clear"], "--clear"],
  ])(
    "%s twice exits 1 'given more than once' without effects",
    async (_l, argv, flag) => {
      const h = makeHarness({
        env: ENV,
        set: mkSet([mkProfile("dev")]),
        isTTY: true,
      });
      await runExpect(
        h,
        argv,
        1,
        `profile ${_l} twice exits 1`,
        "Change D: any flag repeated => 1",
        "Reject repeated flags",
      );
      mustContain(
        h.errText(),
        [flag, "given more than once"],
        `profile ${_l} twice message`,
        "Change D",
        "Name the repeated flag",
      );
      eq(
        effects(h),
        [0, 0, 0, 0],
        `profile ${_l} twice effects`,
        "Change D: no side effects",
        "Reject before acting",
      );
    },
  );
});
