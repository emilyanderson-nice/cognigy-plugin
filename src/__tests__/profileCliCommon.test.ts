import { describe, it } from "@jest/globals";
import { profileUsage } from "../profiles/profileCli.js";
import {
  mkProfile,
  mkSet,
  makeHarness,
  KEY,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const SUBCOMMANDS = ["add", "list", "show", "remove", "default", "test"];
const SET = mkSet([mkProfile("dev"), mkProfile("prod")], "dev");

describe("profile CLI common behaviour (spec 0, 7, 8)", () => {
  it("profileUsage lists every subcommand", () => {
    const text = profileUsage();
    mustContain(
      text,
      SUBCOMMANDS,
      "profileUsage lists subcommands",
      "Spec 0: usage text lists add, list, show, remove, default, test",
      "Include each subcommand name in the usage text",
    );
  });

  it.each([[[]], [["help"]], [["--help"]], [["-h"]]] as string[][][])(
    "argv %j prints usage to out, nothing to err, exit 0",
    async (argv) => {
      const h = makeHarness({ set: SET });
      await runExpect(
        h,
        argv,
        0,
        `profile ${JSON.stringify(argv)} exits 0`,
        "Spec 0: no subcommand/help/--help/-h => usage, 0",
        "Treat these as a help request",
      );
      eq(
        h.outText().includes(profileUsage().trim()),
        true,
        `profile ${JSON.stringify(argv)} prints profileUsage() to out`,
        "Spec 0: usage goes to out",
        "Write the usage text to the stdout writer",
      );
      eq(
        h.errText(),
        "",
        `profile ${JSON.stringify(argv)} writes nothing to err`,
        "Spec 0: help is not an error",
        "Keep stderr empty for help requests",
      );
      eq(
        [h.upserts.length, h.removes.length, h.defaults.length, h.gets.length],
        [0, 0, 0, 0],
        `profile ${JSON.stringify(argv)} has no side effects`,
        "Spec 0: help only prints",
        "Do not touch the store or network",
      );
    },
  );

  it("unknown subcommand: usage to err, line naming it, exit 1, out empty", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["frobnicate"],
      1,
      "profile frobnicate exits 1",
      "Spec 0: unknown subcommand => 1",
      "Reject unknown subcommands with exit code 1",
    );
    mustContain(
      h.errText(),
      ["frobnicate", ...SUBCOMMANDS],
      "profile frobnicate error text",
      "Spec 0: usage to err plus a line naming the subcommand",
      "Print the usage and name the offending word on stderr",
    );
    eq(
      h.outText(),
      "",
      "profile frobnicate stdout",
      "Spec 0: errors go to err only",
      "Keep stdout empty",
    );
  });

  // Spec 7: unknown flags name the flag and the subcommand.
  it.each([
    ["add", ["add", "dev", "--bogus-flag"]],
    ["list", ["list", "--bogus-flag"]],
    ["show", ["show", "dev", "--bogus-flag"]],
    ["remove", ["remove", "dev", "--bogus-flag"]],
    ["default", ["default", "dev", "--bogus-flag"]],
    ["test", ["test", "dev", "--bogus-flag"]],
  ])(
    "%s rejects an unknown flag, naming flag and subcommand",
    async (sub, argv) => {
      const h = makeHarness({ set: SET, isTTY: true });
      await runExpect(
        h,
        argv,
        1,
        `profile ${sub} --bogus-flag exits 1`,
        "Spec 7: unknown flags => 1",
        "Reject unrecognised flags",
      );
      mustContain(
        h.errText(),
        ["--bogus-flag", sub],
        `profile ${sub} --bogus-flag error text`,
        "Spec 7: message names the flag and the subcommand",
        "Mention both the unknown flag and the subcommand on stderr",
      );
      eq(
        [h.upserts.length, h.removes.length, h.defaults.length, h.gets.length],
        [0, 0, 0, 0],
        `profile ${sub} --bogus-flag has no side effects`,
        "Spec 7: parse errors occur before any action",
        "Validate options before acting",
      );
    },
  );

  // Spec 7: a flag missing its value (trailing) => 1.
  it.each([
    "--api-base-url",
    "--api-key-env",
    "--api-key",
    "--endpoint-base-url",
    "--webchat-base-url",
    "--static-files-base-url",
    "--version-hint",
  ])(
    "add: trailing %s without a value exits 1 and writes nothing",
    async (flag) => {
      const h = makeHarness({ set: mkSet([]), isTTY: false });
      await runExpect(
        h,
        ["add", "dev", flag],
        1,
        `profile add dev ${flag} (no value) exits 1`,
        "Spec 7: a flag missing its value => 1",
        "Reject value flags that have no value",
      );
      mustContain(
        h.errText(),
        [flag],
        `profile add dev ${flag} error text`,
        "Spec 7: message names the flag",
        "Name the flag that lacks a value",
      );
      eq(
        h.upserts.length,
        0,
        `profile add dev ${flag} writes nothing`,
        "Spec 7: invalid input must not save",
        "Do not call the store",
      );
    },
  );

  // Spec 7: duplicate positional args => 1.
  it.each([
    ["add", ["add", "a", "b"]],
    ["show", ["show", "a", "b"]],
    ["remove", ["remove", "a", "b", "--yes"]],
    ["default", ["default", "a", "b"]],
    ["test", ["test", "a", "b"]],
  ])(
    "%s with two positional names exits 1 without side effects",
    async (sub, argv) => {
      const h = makeHarness({
        set: mkSet([mkProfile("a"), mkProfile("b")]),
        isTTY: true,
      });
      await runExpect(
        h,
        argv,
        1,
        `profile ${sub} a b exits 1`,
        "Spec 7: duplicate positional arguments => 1",
        "Accept at most one positional name",
      );
      eq(
        [h.upserts.length, h.removes.length, h.defaults.length, h.gets.length],
        [0, 0, 0, 0],
        `profile ${sub} a b has no side effects`,
        "Spec 7: usage errors precede any action",
        "Validate positionals first",
      );
    },
  );

  // Spec 0 / 8: secrets never leak on failure paths, even from fake errors.
  it("a failing getter whose error embeds the key never leaks it (test, all)", async () => {
    const h = makeHarness({
      set: SET,
      httpHandler: () => {
        throw Object.assign(new Error(`bad ${KEY} at https://x/?k=${KEY}`), {
          status: 500,
        });
      },
    });
    await runExpect(
      h,
      ["test", "--all"],
      2,
      "profile test --all with key-bearing errors exits 2",
      "Spec 6/0: failures give exit 2 and never echo secrets",
      "Report only status/fixed text",
    );
    mustNotContain(
      h.outText() + h.errText(),
      ["bad ", "https://x/"],
      "thrown error messages are not printed",
      "Spec 6: never print the thrown message",
      "Print only HTTP status or a fixed text",
    );
  });

  it("guard fails when the code under test writes to process.stderr directly", async () => {
    const h = makeHarness({ set: SET });
    h.deps.out = () => {
      process.stderr.write("x");
    };
    let message = "";
    try {
      await h.run(["list"]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok(
      message.includes("Spec 8"),
      "harness direct-output guard",
      "Spec 8: direct process output must be detected",
      "run() throws a Spec 8 failure",
      JSON.stringify(message),
      "Keep the guard armed for real writes",
    );
  });

  it("guard ignores Node warning text written during the run", async () => {
    const h = makeHarness({ set: SET });
    h.deps.out = () => {
      process.stderr.write(
        "(node:1) ExperimentalWarning: VM Modules is an experimental feature\n",
      );
      console.error("(Use `node --trace-warnings ...` to show where)");
    };
    await runExpect(
      h,
      ["list"],
      0,
      "profile list with Node warning noise exits 0",
      "Spec 8: only code-under-test output counts",
      "Ignore Node runtime warnings",
    );
  });

  it("harness sanity: tests actually use the distinctive key (guard is live)", () => {
    ok(
      mkProfile("dev").apiKey === KEY,
      "fixture profile carries the distinctive key",
      "Spec 0 test setup: leak guard is meaningful only if the fixture holds the key",
      "apiKey === KEY",
      "apiKey differs",
      "Fix the fixture builder",
    );
  });
});
