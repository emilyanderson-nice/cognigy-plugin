import { describe, it } from "@jest/globals";
import { loadProfiles } from "../profiles/profiles.js";
import {
  CONFIG_PATH,
  KEY,
  makeHarness,
  mkProfile,
  mkSet,
} from "./helpers/profileCliHarness.js";
import { mustContain, runExpect } from "./helpers/profileCliAsserts.js";
import { eq } from "./helpers/specAssert.js";

/** A REAL ProfileConfigError: saved defaultProfile names a missing profile. */
function realConfigError(): Error {
  try {
    loadProfiles({
      env: {},
      fileProfiles: {
        defaultProfile: "missing-one",
        profiles: {
          alpha: { apiBaseUrl: "https://alpha.test", apiKey: "fake-key-aaaa" },
        },
        problems: [],
      },
    });
  } catch (e) {
    return e as Error;
  }
  throw new Error("test setup: loadProfiles did not throw");
}

const URL = "https://api-dev.cognigy.ai";
const ENV = { CGKEY: KEY } as NodeJS.ProcessEnv;

describe("loader errors do not brick the CLI (change C)", () => {
  it.each([
    ["list", ["list"]],
    ["list --json", ["list", "--json"]],
    ["show", ["show", "dev"]],
    ["remove", ["remove", "dev", "--yes"]],
    ["default <name>", ["default", "dev"]],
    ["test", ["test"]],
    ["test --all", ["test", "--all"]],
    [
      "add",
      [
        "add",
        "dev",
        "--api-base-url",
        URL,
        "--api-key-env",
        "CGKEY",
        "--no-test",
      ],
    ],
  ])(
    "%s: prints message and hints, exits 1, never rejects, no side effects",
    async (_label, argv) => {
      const err = realConfigError();
      const h = makeHarness({ env: ENV, loadThrows: err });
      await runExpect(
        h,
        argv,
        1,
        `profile ${_label} with a throwing loader exits 1`,
        "Change C: ProfileConfigError is caught and reported",
        "Catch loader errors in every subcommand and return 1",
      );
      mustContain(
        h.outText() + h.errText(),
        [
          err.message,
          "cognigy-setup profile default --clear",
          "COGNIGY_PROFILE",
        ],
        `profile ${_label} loader error output`,
        "Change C: error message plus a hint for a saved default and for the env variable",
        "Print the message and both fix hints",
      );
      eq(
        [h.upserts.length, h.removes.length, h.defaults.length, h.gets.length],
        [0, 0, 0, 0],
        `profile ${_label} loader error has no side effects`,
        "Change C",
        "Do not act when the profile set cannot be loaded",
      );
    },
  );

  it("default --clear still works when the loader throws (store called, exit 0)", async () => {
    const h = makeHarness({ loadThrows: realConfigError() });
    await runExpect(
      h,
      ["default", "--clear"],
      0,
      "profile default --clear with a throwing loader exits 0",
      "Change C exception: --clear must not need the loader",
      "Clear the default without loading profiles",
    );
    eq(
      h.defaults,
      [{ name: undefined, options: { path: CONFIG_PATH } }],
      "profile default --clear store call",
      "Change C: setDefaultProfile(undefined, { path })",
      "Call the store directly",
    );
  });
});

const SET = mkSet([mkProfile("dev")]);
const HELP: [string, string[]][] = [
  [
    "add",
    [
      "--api-base-url",
      "--api-key-env",
      "--api-key",
      "--endpoint-base-url",
      "--webchat-base-url",
      "--static-files-base-url",
      "--version-hint",
      "--default",
      "--force",
      "--no-test",
    ],
  ],
  ["list", ["--json"]],
  ["show", ["show"]],
  ["remove", ["--yes"]],
  ["default", ["--clear"]],
  ["test", ["--all"]],
];

describe("per-subcommand help (change H)", () => {
  it.each(
    HELP.flatMap(([sub, words]) =>
      ["--help", "-h"].map(
        (f) => [sub, f, words] as [string, string, string[]],
      ),
    ),
  )(
    "%s %s prints that subcommand's usage, exit 0, no store/loader/getter",
    async (sub, flag, words) => {
      const h = makeHarness({ set: SET, isTTY: true });
      await runExpect(
        h,
        [sub, flag],
        0,
        `profile ${sub} ${flag} exits 0`,
        "Change H: per-subcommand help",
        "Treat --help/-h after a subcommand as a help request",
      );
      mustContain(
        h.outText(),
        words,
        `profile ${sub} ${flag} usage`,
        "Change H: usage mentions the subcommand's flags",
        "List every flag the subcommand accepts",
      );
      eq(
        [
          h.errText(),
          h.loadCalls(),
          h.upserts.length,
          h.removes.length,
          h.defaults.length,
          h.getters.length,
          h.asked.length,
        ],
        ["", 0, 0, 0, 0, 0, 0],
        `profile ${sub} ${flag} has no effects`,
        "Change H: help never calls the store, loader or getter and prints nothing to err",
        "Print help and return before doing anything else",
      );
    },
  );
});
