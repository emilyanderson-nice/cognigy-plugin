/**
 * G3: after a successful `add` that takes the configured environments from
 * exactly one to two or more, a notice on `out` explains that every tool call
 * must now name an environment.
 */
import { describe, it } from "@jest/globals";
import {
  KEY,
  makeHarness,
  mkProfile,
  mkSet,
  type Harness,
  type HarnessOptions,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { ok } from "./helpers/specAssert.js";

const ENV = { CGKEY: KEY } as NodeJS.ProcessEnv;
const ARGS = (name: string, ...extra: string[]) => [
  "add",
  name,
  "--api-base-url",
  "https://api-new.cognigy.ai",
  "--api-key-env",
  "CGKEY",
  "--no-test",
  ...extra,
];
const dev = () => mkProfile("dev", "file-profile");
const prod = () => mkProfile("prod", "file-profile");

async function added(
  opts: HarnessOptions,
  argv: string[],
  code = 0,
): Promise<Harness> {
  const h = makeHarness({ env: ENV, ...opts });
  await runExpect(
    h,
    argv,
    code,
    `profile ${argv.join(" ")} exits ${code}`,
    "G3: fixture command outcome",
    "Keep the add outcome unchanged.",
  );
  return h;
}

const NOTICE_WORDS = ["environment", "every", "list_environments"];

describe("G3 profile add: multi-environment notice", () => {
  it("1 -> 2 environments: notice on out with the count, no key, nothing on err", async () => {
    const h = await added({ set: mkSet([dev()], "dev") }, ARGS("prod"));
    mustContain(
      h.outText(),
      [...NOTICE_WORDS, "2"],
      "notice content",
      "G3: notice names the environment argument, `every` call, list_environments and the new count 2",
      "Print the Note line after the confirmation.",
    );
    mustNotContain(
      h.errText(),
      ["list_environments", "every"],
      "notice channel",
      "G3: the notice goes to out, not err",
      "Write the notice to out.",
    );
    mustNotContain(
      h.outText(),
      [KEY],
      "notice secrecy",
      "G3: the key never appears",
      "Never print key material.",
    );
  });

  it("1 usable + 1 problem is already 2: adding a third gives no notice; a lone problem + add gives one", async () => {
    const two = await added(
      {
        set: mkSet([dev()], "dev", [{ name: "bad", reason: "missing url" }]),
      },
      ARGS("prod"),
    );
    mustNotContain(
      two.outText(),
      ["list_environments"],
      "2+ before (problem counted)",
      "G3: problems count as configured names, so 2 before means no notice",
      "Count distinct names of profiles plus problems.",
    );
    const lone = await added(
      { set: mkSet([], undefined, [{ name: "bad", reason: "missing url" }]) },
      ARGS("prod"),
    );
    mustContain(
      lone.outText(),
      NOTICE_WORDS,
      "1 problem before",
      "G3: a lone problem counts as one configured environment",
      "Count problems too.",
    );
  });

  it.each([
    ["0 before", () => mkSet([])],
    ["2 before", () => mkSet([dev(), prod()], "dev")],
  ])("%s: no notice", async (_l, set) => {
    const h = await added({ set: set() }, ARGS("third"));
    mustNotContain(
      h.outText() + h.errText(),
      ["list_environments", "every tool call"],
      `no notice (${_l})`,
      "G3: only a 1 -> 2+ transition prints the notice",
      "Print the notice only when the count was exactly 1 before.",
    );
  });

  it("replacing an existing name (--force) keeps the count: no notice", async () => {
    const h = await added(
      { set: mkSet([dev()], "dev") },
      ARGS("dev", "--force"),
    );
    mustNotContain(
      h.outText() + h.errText(),
      ["list_environments"],
      "replace no notice",
      "G3: count unchanged, no notice",
      "Compare counts before and after.",
    );
  });

  it("--force over a shadowed name keeps the count: no notice", async () => {
    const h = await added(
      { set: mkSet([mkProfile("dev", "env-profile")], "dev") },
      ARGS("dev", "--force"),
    );
    mustNotContain(
      h.outText() + h.errText(),
      ["list_environments"],
      "shadowed no notice",
      "G3: the shadowing definition still wins, so the count is unchanged",
      "Compute the count after the write from the loaded set.",
    );
  });

  it("a failed add prints no notice", async () => {
    const h = await added(
      { set: mkSet([dev()], "dev") },
      ["add", "-bad-name", ...ARGS("x").slice(2)],
      1,
    );
    ok(
      !(h.outText() + h.errText()).includes("list_environments") &&
        h.upserts.length === 0,
      "failed add no notice",
      "G3: no notice when add fails",
      "no list_environments text and no write",
      JSON.stringify([h.outText(), h.errText(), h.upserts.length]),
      "Print the notice only after a successful write.",
    );
  });
});
