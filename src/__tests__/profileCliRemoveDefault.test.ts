import { describe, it } from "@jest/globals";
import {
  CONFIG_PATH,
  makeHarness,
  mkProfile,
  mkSet,
  type Harness,
  type Source,
} from "./helpers/profileCliHarness.js";
import { mustContain, runExpect } from "./helpers/profileCliAsserts.js";
import { eq } from "./helpers/specAssert.js";

const SET = mkSet([
  mkProfile("dev", "file-profile"),
  mkProfile("stg", "env-profile"),
  mkProfile("old", "legacy-file"),
  mkProfile("leg", "legacy-env"),
]);
const writes = (h: Harness): number[] => [h.removes.length, h.defaults.length];

describe("profile remove (spec 4)", () => {
  it.each<[Source, string]>([
    ["env-profile", "stg"],
    ["legacy-file", "old"],
    ["legacy-env", "leg"],
  ])(
    "%s profile cannot be removed: exit 1 explaining origin",
    async (source, name) => {
      const h = makeHarness({ set: SET, isTTY: true });
      await runExpect(
        h,
        ["remove", name, "--yes"],
        1,
        `profile remove ${name} (${source}) exits 1`,
        "Spec 4: only file profiles can be removed",
        "Refuse and explain",
      );
      mustContain(
        h.errText(),
        source === "legacy-file" ? ["legacy"] : ["environment variables"],
        `profile remove ${name} (${source}) message`,
        "Spec 4: names where it comes from and that it cannot be removed here",
        "Explain the origin",
        true,
      );
      eq(
        [writes(h), h.asked.length],
        [[0, 0], 0],
        `profile remove ${name} (${source}) no write/prompt`,
        "Spec 4",
        "Do not call the store",
      );
    },
  );

  it("unknown name exits 1 without writing", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["remove", "nope", "--yes"],
      1,
      "profile remove nope exits 1",
      "Spec 4",
      "Fail",
    );
    eq(
      h.removes.length,
      0,
      "profile remove nope no write",
      "Spec 4",
      "No write",
    );
  });

  it("non-TTY without --yes exits 1 saying --yes is required, no prompt, no write", async () => {
    const h = makeHarness({ set: SET, isTTY: false });
    await runExpect(
      h,
      ["remove", "dev"],
      1,
      "profile remove dev (non-TTY) exits 1",
      "Spec 4",
      "Fail",
    );
    mustContain(
      h.errText(),
      ["--yes"],
      "profile remove non-TTY message",
      "Spec 4",
      "Mention --yes",
    );
    eq(
      [writes(h), h.asked.length],
      [[0, 0], 0],
      "profile remove non-TTY effects",
      "Spec 4",
      "No prompt/write",
    );
  });

  it.each(["y", "yes", "Y", "YES", "Yes"])(
    "TTY answer %j proceeds with the removal",
    async (answer) => {
      const h = makeHarness({ set: SET, isTTY: true, asks: [answer] });
      await runExpect(
        h,
        ["remove", "DEV"],
        0,
        `profile remove DEV answered ${answer} exits 0`,
        "Spec 4",
        "Succeed",
      );
      eq(
        h.asked,
        ["Remove environment 'dev'? [y/N] "],
        "profile remove prompt text",
        "Spec 4: exact question with normalised name",
        "Ask exactly this question",
      );
      eq(
        h.removes,
        [{ name: "dev", options: { path: CONFIG_PATH } }],
        "profile remove store call",
        "Spec 4: removeProfile(name, { path })",
        "Remove the normalised name",
      );
      mustContain(
        h.outText(),
        ["dev"],
        "profile remove confirmation",
        "Spec 4: prints a confirmation",
        "Confirm",
      );
    },
  );

  it.each(["", "n", "N", "no", "yep", "y es", "maybe"])(
    "TTY answer %j cancels: prints Cancelled., exit 0, no removal",
    async (answer) => {
      const h = makeHarness({ set: SET, isTTY: true, asks: [answer] });
      await runExpect(
        h,
        ["remove", "dev"],
        0,
        `profile remove answered ${JSON.stringify(answer)} exits 0`,
        "Spec 4: anything but y/yes cancels with 0",
        "Cancel",
      );
      mustContain(
        h.outText(),
        ["Cancelled."],
        "profile remove cancel message",
        "Spec 4",
        "Print Cancelled.",
      );
      eq(
        h.removes.length,
        0,
        "profile remove cancelled no write",
        "Spec 4",
        "Do not remove",
      );
    },
  );

  it("--yes skips the prompt (TTY and non-TTY) and removes", async () => {
    for (const isTTY of [true, false]) {
      const h = makeHarness({ set: SET, isTTY });
      await runExpect(
        h,
        ["remove", "dev", "--yes"],
        0,
        `profile remove --yes (TTY=${isTTY}) exits 0`,
        "Spec 4",
        "Succeed",
      );
      eq(
        [h.asked.length, h.removes],
        [0, [{ name: "dev", options: { path: CONFIG_PATH } }]],
        `profile remove --yes (TTY=${isTTY})`,
        "Spec 4: --yes skips the confirmation",
        "Do not ask",
      );
    }
  });

  it("store returning false: says not found in the config file, exit 1", async () => {
    const h = makeHarness({ set: SET, removeResult: false });
    await runExpect(
      h,
      ["remove", "dev", "--yes"],
      1,
      "profile remove (store false) exits 1",
      "Spec 4",
      "Fail",
    );
    mustContain(
      h.errText() + h.outText(),
      ["not found", "config"],
      "profile remove not-found message",
      "Spec 4: not found in the config file",
      "Say so",
      true,
    );
    eq(
      h.removes.length,
      1,
      "profile remove attempted once",
      "Spec 4",
      "Call the store once",
    );
  });
});

describe("profile default (spec 5)", () => {
  it("--clear clears the default (undefined name), exit 0", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["default", "--clear"],
      0,
      "profile default --clear exits 0",
      "Spec 5",
      "Succeed",
    );
    eq(
      h.defaults,
      [{ name: undefined, options: { path: CONFIG_PATH } }],
      "profile default --clear store call",
      "Spec 5: setDefaultProfile(undefined, { path })",
      "Clear via the store",
    );
  });

  it("a file profile becomes the default (normalised) and is confirmed", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["default", "DEV"],
      0,
      "profile default DEV exits 0",
      "Spec 5",
      "Succeed",
    );
    eq(
      h.defaults,
      [{ name: "dev", options: { path: CONFIG_PATH } }],
      "profile default store call",
      "Spec 5",
      "Persist the normalised name",
    );
    mustContain(
      h.outText(),
      ["dev"],
      "profile default confirmation",
      "Spec 5",
      "Confirm",
    );
  });

  it("unknown name exits 1 listing names, no write", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["default", "nope"],
      1,
      "profile default nope exits 1",
      "Spec 5",
      "Fail",
    );
    mustContain(
      h.errText(),
      ["dev", "stg", "old"],
      "profile default unknown message",
      "Spec 5: lists names",
      "List names",
    );
    eq(
      h.defaults.length,
      0,
      "profile default nope no write",
      "Spec 5",
      "No write",
    );
  });

  it.each<[Source, string]>([
    ["env-profile", "stg"],
    ["legacy-file", "old"],
    ["legacy-env", "leg"],
  ])(
    "%s profile cannot be persisted: exit 1 pointing at COGNIGY_PROFILE",
    async (_s, name) => {
      const h = makeHarness({ set: SET });
      await runExpect(
        h,
        ["default", name],
        1,
        `profile default ${name} exits 1`,
        "Spec 5: non-file profiles cannot be persisted as default",
        "Refuse",
      );
      mustContain(
        h.errText(),
        ["COGNIGY_PROFILE", name],
        `profile default ${name} message`,
        "Spec 5: says to set COGNIGY_PROFILE naming the profile",
        "Point to the environment variable",
        false,
      );
      eq(
        h.defaults.length,
        0,
        `profile default ${name} no write`,
        "Spec 5",
        "No write",
      );
    },
  );

  it("no name and no --clear exits 1 without writing", async () => {
    const h = makeHarness({ set: SET });
    await runExpect(
      h,
      ["default"],
      1,
      "profile default (no args) exits 1",
      "Spec 5: needs a name or --clear",
      "Fail",
    );
    eq(
      h.defaults.length,
      0,
      "profile default (no args) no write",
      "Spec 5",
      "No write",
    );
  });
});
