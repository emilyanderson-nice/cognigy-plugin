import { describe, it } from "@jest/globals";
import {
  CONFIG_PATH,
  KEY,
  makeHarness,
  mkSet,
  type Harness,
} from "./helpers/profileCliHarness.js";
import {
  mustContain,
  mustNotContain,
  runExpect,
} from "./helpers/profileCliAsserts.js";
import { eq } from "./helpers/specAssert.js";

const URL = "https://api-dev.cognigy.ai";
const ENV = { CGKEY: KEY } as NodeJS.ProcessEnv;
const BASE = ["--api-base-url", URL, "--api-key-env", "CGKEY", "--no-test"];

const noWrites = (h: Harness): number[] => [
  h.upserts.length,
  h.defaults.length,
  h.removes.length,
];

describe("profile add: name handling (spec 1)", () => {
  it.each([
    ["V4_Staging", "v4-staging"],
    ["DEV", "dev"],
    ["my_Env_2", "my-env-2"],
    ["already-ok", "already-ok"],
  ])("name %s is stored as %s", async (given, stored) => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", given, ...BASE],
      0,
      `profile add ${given} exits 0`,
      "Spec 1: names are lowercased with _ replaced by -",
      "Accept and normalise valid names",
    );
    eq(
      h.upserts.map((u) => u.name),
      [stored],
      `profile add ${given} stores the normalised name`,
      "Spec 1: store receives the normalised name",
      "Normalise before calling the store",
    );
    mustContain(
      h.outText(),
      [stored],
      `profile add ${given} confirmation`,
      "Spec 1: confirmation line includes the name",
      "Print the saved (normalised) name",
    );
  });

  it.each([
    ["empty", ""],
    ["leading hyphen", "-dev"],
    ["leading underscore (becomes hyphen)", "_dev"],
    ["__proto__", "__proto__"],
    ["contains spaces", "my env"],
  ])("invalid name (%s) exits 1 and writes nothing", async (_label, name) => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", name, ...BASE],
      1,
      `profile add ${JSON.stringify(name)} exits 1`,
      "Spec 1: invalid names are rejected",
      "Validate the name before saving",
    );
    eq(
      noWrites(h),
      [0, 0, 0],
      `profile add ${JSON.stringify(name)} writes nothing`,
      "Spec 1: invalid input never reaches the store",
      "Reject before any write",
    );
  });

  it("missing name exits 1 and writes nothing", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", ...BASE],
      1,
      "profile add (no name) exits 1",
      "Spec 1: an empty name is invalid",
      "Require a name",
    );
    eq(
      noWrites(h),
      [0, 0, 0],
      "profile add (no name) writes nothing",
      "Spec 1",
      "Do not call the store",
    );
  });
});

describe("profile add: flags and store call (spec 1)", () => {
  const FULL: [string, string][] = [
    ["--api-base-url", URL],
    ["--api-key-env", "CGKEY"],
    ["--endpoint-base-url", "https://endpoint-dev.cognigy.ai"],
    ["--webchat-base-url", "https://webchat-dev.cognigy.ai"],
    ["--static-files-base-url", "https://static-dev.cognigy.ai"],
    ["--version-hint", "2026.21"],
  ];
  const EXPECTED = {
    apiBaseUrl: URL,
    apiKey: KEY,
    endpointBaseUrl: "https://endpoint-dev.cognigy.ai",
    webchatBaseUrl: "https://webchat-dev.cognigy.ai",
    staticFilesBaseUrl: "https://static-dev.cognigy.ai",
    versionHint: "2026.21",
  };

  it.each([
    ["--flag value", FULL.flatMap(([f, v]) => [f, v])],
    ["--flag=value", FULL.map(([f, v]) => `${f}=${v}`)],
  ])("%s form passes every field to the store", async (_form, flags) => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", "dev", ...flags, "--no-test"],
      0,
      `profile add (${_form}) exits 0`,
      "Spec 1: both flag forms are accepted",
      "Support --flag value and --flag=value",
    );
    eq(
      h.upserts,
      [{ name: "dev", profile: EXPECTED, options: { path: CONFIG_PATH } }],
      `profile add (${_form}) store call`,
      "Spec 1: upsertProfile(name, fields, { path: configPath }) exactly once",
      "Pass every flag value and the configPath through to the store",
    );
  });

  it("only api url and key are sent when optional flags are absent", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", "dev", ...BASE],
      0,
      "profile add minimal exits 0",
      "Spec 1",
      "Optional flags are optional",
    );
    eq(
      h.upserts.map((u) =>
        Object.keys(u.profile)
          .filter((k) => u.profile[k] !== undefined)
          .sort(),
      ),
      [["apiBaseUrl", "apiKey"]],
      "profile add minimal store fields",
      "Spec 1: unspecified optional fields are not invented",
      "Send only provided values",
    );
  });

  it("values are trimmed before saving", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      [
        "add",
        "dev",
        "--api-base-url",
        `  ${URL}  `,
        "--api-key-env",
        "CGKEY",
        "--version-hint",
        "  2026.21 ",
        "--no-test",
      ],
      0,
      "profile add with padded values exits 0",
      "Spec 1: trimmed values",
      "Trim input",
    );
    eq(
      [h.upserts[0]?.profile.apiBaseUrl, h.upserts[0]?.profile.versionHint],
      [URL, "2026.21"],
      "profile add trims url and version hint",
      "Spec 1: store receives trimmed values",
      "Trim whitespace",
    );
  });

  it("confirmation shows name and API host only (no path, no key)", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      [
        "add",
        "dev",
        "--api-base-url",
        `${URL}/private/path`,
        "--api-key-env",
        "CGKEY",
        "--no-test",
      ],
      0,
      "profile add confirmation exits 0",
      "Spec 1",
      "Succeed",
    );
    mustContain(
      h.outText(),
      ["dev", "api-dev.cognigy.ai"],
      "profile add confirmation line",
      "Spec 1: confirmation has name and API host",
      "Print name and hostname",
    );
    mustNotContain(
      h.outText(),
      ["/private/path", "https://"],
      "profile add confirmation host only",
      "Spec 1: API HOST ONLY (never full URL/key)",
      "Print only the hostname",
    );
  });

  it("--default also sets the default after saving; without it, none", async () => {
    const withDefault = makeHarness({ env: ENV });
    await runExpect(
      withDefault,
      ["add", "V4_Dev", ...BASE, "--default"],
      0,
      "profile add --default exits 0",
      "Spec 1",
      "Succeed",
    );
    eq(
      [withDefault.upserts.length, withDefault.defaults],
      [1, [{ name: "v4-dev", options: { path: CONFIG_PATH } }]],
      "profile add --default calls setDefaultProfile",
      "Spec 1: setDefaultProfile(name, { path })",
      "Set the normalised name as default",
    );
    const without = makeHarness({ env: ENV });
    await runExpect(
      without,
      ["add", "dev", ...BASE],
      0,
      "profile add (no --default) exits 0",
      "Spec 1",
      "Succeed",
    );
    eq(
      without.defaults.length,
      0,
      "profile add without --default leaves default alone",
      "Spec 1: only --default sets default",
      "Do not call setDefaultProfile",
    );
  });
});

describe("profile add: api base url source (spec 1)", () => {
  it("TTY: missing --api-base-url is asked for, trimmed and saved", async () => {
    const h = makeHarness({ env: ENV, isTTY: true, asks: [`  ${URL} `] });
    await runExpect(
      h,
      ["add", "dev", "--api-key-env", "CGKEY", "--no-test"],
      0,
      "profile add (prompted url) exits 0",
      "Spec 1: prompt via ask when TTY",
      "Ask for the API base URL",
    );
    eq(
      [h.asked.length, h.upserts[0]?.profile.apiBaseUrl],
      [1, URL],
      "profile add prompts once for the url",
      "Spec 1",
      "Use the answer as apiBaseUrl",
    );
  });

  it("non-TTY: missing --api-base-url exits 1 saying it is required, no prompt", async () => {
    const h = makeHarness({ env: ENV, isTTY: false });
    await runExpect(
      h,
      ["add", "dev", "--api-key-env", "CGKEY", "--no-test"],
      1,
      "profile add (no url, non-TTY) exits 1",
      "Spec 1: non-TTY cannot prompt",
      "Fail with an explanatory message",
    );
    mustContain(
      h.errText(),
      ["--api-base-url", "required"],
      "profile add missing url message",
      "Spec 1: says it is required",
      "Mention --api-base-url is required",
    );
    eq(
      [h.asked.length, noWrites(h)],
      [0, [0, 0, 0]],
      "profile add (no url, non-TTY) no prompt and no write",
      "Spec 1",
      "No interaction and no write",
    );
  });
});

describe("profile add: key source precedence (spec 1)", () => {
  it("--api-key-env reads deps.env[VAR]", async () => {
    const h = makeHarness({ env: { OTHER: KEY } as NodeJS.ProcessEnv });
    await runExpect(
      h,
      [
        "add",
        "dev",
        "--api-base-url",
        URL,
        "--api-key-env",
        "OTHER",
        "--no-test",
      ],
      0,
      "profile add --api-key-env exits 0",
      "Spec 1",
      "Read the named variable",
    );
    eq(
      h.upserts[0]?.profile.apiKey,
      KEY,
      "profile add --api-key-env value",
      "Spec 1: key comes from deps.env[VAR]",
      "Use the injected env",
    );
  });

  it.each([
    ["unset", {} as NodeJS.ProcessEnv],
    ["empty", { CGKEY: "" } as NodeJS.ProcessEnv],
  ])(
    "--api-key-env variable %s exits 1 naming VAR, no write",
    async (_l, env) => {
      const h = makeHarness({ env, isTTY: true, hiddenAsks: [KEY] });
      await runExpect(
        h,
        [
          "add",
          "dev",
          "--api-base-url",
          URL,
          "--api-key-env",
          "CGKEY",
          "--no-test",
        ],
        1,
        `profile add --api-key-env (${_l}) exits 1`,
        "Spec 1: unset/empty => 1 naming the variable",
        "Do not fall back to another key source",
      );
      mustContain(
        h.errText(),
        ["CGKEY"],
        `profile add --api-key-env (${_l}) message`,
        "Spec 1: names VAR",
        "Name the variable",
      );
      eq(
        [noWrites(h), h.askedHidden.length],
        [[0, 0, 0], 0],
        `profile add --api-key-env (${_l}) no write, no prompt`,
        "Spec 1: --api-key-env takes precedence over the prompt",
        "Fail instead of prompting",
      );
    },
  );

  it("--api-key-env beats --api-key and the prompt", async () => {
    const h = makeHarness({
      env: ENV,
      isTTY: true,
      hiddenAsks: ["prompt-key-cccc"],
    });
    await runExpect(
      h,
      [
        "add",
        "dev",
        "--api-base-url",
        URL,
        "--api-key-env",
        "CGKEY",
        "--api-key",
        "cli-key-bbbb",
        "--no-test",
      ],
      0,
      "profile add (env + cli key) exits 0",
      "Spec 1: env > --api-key > prompt",
      "Prefer --api-key-env",
    );
    eq(
      [h.upserts[0]?.profile.apiKey, h.askedHidden.length],
      [KEY, 0],
      "profile add env key precedence",
      "Spec 1",
      "Use the env-provided key and do not prompt",
    );
  });

  it("--api-key saves the key and warns on err about shell history", async () => {
    const h = makeHarness({ isTTY: true, hiddenAsks: ["unused-dddd"] });
    await runExpect(
      h,
      ["add", "dev", "--api-base-url", URL, `--api-key=${KEY}`, "--no-test"],
      0,
      "profile add --api-key exits 0",
      "Spec 1",
      "Accept --api-key",
    );
    eq(
      [h.upserts[0]?.profile.apiKey, h.askedHidden.length],
      [KEY, 0],
      "profile add --api-key stored key",
      "Spec 1: --api-key beats the prompt",
      "Use the command-line key",
    );
    mustContain(
      h.errText(),
      ["history", "--api-key-env"],
      "profile add --api-key warning",
      "Spec 1: warning that the key is stored in shell history; prefer --api-key-env or prompt",
      "Write the warning to err",
      true,
    );
  });

  it("TTY without key flags uses the hidden prompt", async () => {
    const h = makeHarness({ isTTY: true, hiddenAsks: [KEY] });
    await runExpect(
      h,
      ["add", "dev", "--api-base-url", URL, "--no-test"],
      0,
      "profile add (hidden prompt) exits 0",
      "Spec 1: interactive hidden prompt via askHidden",
      "Prompt for the key",
    );
    eq(
      [h.askedHidden.length, h.asked.length, h.upserts[0]?.profile.apiKey],
      [1, 0, KEY],
      "profile add hidden prompt used for the key",
      "Spec 1: key via askHidden, not the visible prompt",
      "Use askHidden for the key",
    );
  });

  it("non-TTY without a key source exits 1 pointing to --api-key-env", async () => {
    const h = makeHarness({ isTTY: false });
    await runExpect(
      h,
      ["add", "dev", "--api-base-url", URL, "--no-test"],
      1,
      "profile add (no key, non-TTY) exits 1",
      "Spec 1: non-TTY cannot prompt for the key",
      "Fail with guidance",
    );
    mustContain(
      h.errText(),
      ["--api-key-env"],
      "profile add (no key, non-TTY) message",
      "Spec 1: tells the user to use --api-key-env",
      "Mention --api-key-env",
    );
    eq(
      [noWrites(h), h.askedHidden.length],
      [[0, 0, 0], 0],
      "profile add (no key, non-TTY) no write/prompt",
      "Spec 1",
      "No interaction and no write",
    );
  });
});
