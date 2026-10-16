import { describe, it } from "@jest/globals";
import {
  KEY,
  makeHarness,
  mkProfile,
  mkSet,
  type Source,
} from "./helpers/profileCliHarness.js";
import { mustContain, runExpect } from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const URL = "https://api-dev.cognigy.ai";
const ENV = { CGKEY: KEY } as NodeJS.ProcessEnv;
const ARGS = ["--api-base-url", URL, "--api-key-env", "CGKEY"];
const all = (h: { outText(): string; errText(): string }): string =>
  h.outText() + h.errText();

describe("profile add --force: check targets the right profile (change A)", () => {
  it.each<Source>(["env-profile", "legacy-env"])(
    "name shadowed by %s: saved, check skipped with a note, exit 0, no requests",
    async (source) => {
      const h = makeHarness({
        env: ENV,
        set: mkSet([mkProfile("dev", source)]),
      });
      await runExpect(
        h,
        ["add", "dev", ...ARGS, "--force"],
        0,
        `profile add --force over ${source} (with check) exits 0`,
        "Change A: a shadowed profile is saved but not checked",
        "Skip the check instead of testing the environment-defined profile",
      );
      eq(
        [h.upserts.length, h.getters.length, h.gets.length],
        [1, 0, 0],
        `profile add --force over ${source}: write yes, requests none`,
        "Change A: reloaded profile is not file-profile => NO check",
        "Only check when the reloaded profile has source file-profile",
      );
      mustContain(
        all(h),
        ["skipped", "environment variables"],
        `profile add --force over ${source} note`,
        "Change A: note that the check was skipped because the name is defined by environment variables",
        "Print the skip note",
        true,
      );
    },
  );

  it("file profile replaced with --force is still checked (the reloaded file profile)", async () => {
    const h = makeHarness({
      env: ENV,
      set: mkSet([mkProfile("dev", "file-profile")]),
    });
    await runExpect(
      h,
      ["add", "dev", ...ARGS, "--force"],
      0,
      "profile add --force over file profile exits 0",
      "Change A",
      "Succeed",
    );
    eq(
      [h.getters.length, h.getters[0]?.source],
      [1, "file-profile"],
      "profile add --force over file profile is checked",
      "Change A: file-profile reloads are checked as before",
      "Run the check",
    );
  });
});

describe("profile add over legacy-file 'default' (change B)", () => {
  const SET = mkSet([mkProfile("default", "legacy-file")]);

  it("without --force: exit 1, says it would replace the legacy config, not shadowed/ignored", async () => {
    const h = makeHarness({ env: ENV, set: SET });
    await runExpect(
      h,
      ["add", "default", ...ARGS, "--no-test"],
      1,
      "profile add default over legacy-file exits 1",
      "Change B: replacing the legacy single-environment config requires --force",
      "Refuse without --force",
    );
    mustContain(
      h.errText(),
      ["--force", "replace", "legacy", "default"],
      "profile add default over legacy-file message",
      "Change B: says it would replace the legacy single-environment config as 'default'",
      "Explain the replacement",
      true,
    );
    ok(
      !/shadow|ignored/i.test(h.errText()),
      "profile add default over legacy-file wording",
      "Change B: a legacy-file entry is replaced, not shadowed",
      "no 'shadowed'/'ignored' wording",
      JSON.stringify(h.errText()),
      "Do not describe replacement as shadowing",
    );
    eq(
      h.upserts.length,
      0,
      "profile add default over legacy-file no write",
      "Change B",
      "No write",
    );
  });

  it("with --force: writes, exit 0, and prints NO precedence warning", async () => {
    const h = makeHarness({ env: ENV, set: SET });
    await runExpect(
      h,
      ["add", "default", ...ARGS, "--no-test", "--force"],
      0,
      "profile add default --force over legacy-file exits 0",
      "Change B",
      "Allow with --force",
    );
    eq(
      h.upserts.length,
      1,
      "profile add default --force writes once",
      "Change B",
      "Save it",
    );
    ok(
      !/precedence|shadow/i.test(all(h)),
      "profile add default --force over legacy-file has no precedence warning",
      "Change B: environment precedence does not apply to legacy-file",
      "no 'precedence'/'shadow' text",
      JSON.stringify(all(h)),
      "Omit the warning",
    );
  });
});
