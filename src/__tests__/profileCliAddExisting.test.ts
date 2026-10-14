import { describe, it } from "@jest/globals";
import {
  KEY,
  OPENAPI_URL,
  PROJECTS_URL,
  CONFIG_PATH,
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

describe("profile add: existing names (spec 1)", () => {
  it.each(["dev", "DEV"])(
    "existing file profile, add %s without --force exits 1, no write",
    async (given) => {
      const h = makeHarness({
        env: ENV,
        set: mkSet([mkProfile("dev", "file-profile")]),
      });
      await runExpect(
        h,
        ["add", given, ...ARGS, "--no-test"],
        1,
        `profile add ${given} over existing file profile exits 1`,
        "Spec 1: existing file profile requires --force",
        "Refuse to replace without --force",
      );
      mustContain(
        h.errText(),
        ["already exists", "--force"],
        `profile add ${given} existing message`,
        "Spec 1: message contains 'already exists' and '--force'",
        "Tell the user to pass --force",
      );
      eq(
        [h.upserts.length, h.defaults.length],
        [0, 0],
        `profile add ${given} existing: no write`,
        "Spec 1: NO write",
        "Do not touch the store",
      );
    },
  );

  it("existing file profile with --force replaces it (exit 0, one upsert)", async () => {
    const h = makeHarness({
      env: ENV,
      set: mkSet([mkProfile("dev", "file-profile")]),
    });
    await runExpect(
      h,
      ["add", "dev", ...ARGS, "--no-test", "--force"],
      0,
      "profile add --force over file profile exits 0",
      "Spec 1: --force allows replacing",
      "Allow replacement",
    );
    eq(
      h.upserts.map((u) => [u.name, u.options]),
      [["dev", { path: CONFIG_PATH }]],
      "profile add --force upsert",
      "Spec 1",
      "Call the store once",
    );
  });

  it.each<[Source, string[]]>([
    ["env-profile", ["environment variables"]],
    ["legacy-env", ["environment variables"]],
  ])(
    "name defined by %s source: exit 1 without --force, explains and does not write",
    async (source, words) => {
      const h = makeHarness({
        env: ENV,
        set: mkSet([mkProfile("dev", source)]),
      });
      await runExpect(
        h,
        ["add", "dev", ...ARGS, "--no-test"],
        1,
        `profile add over ${source} exits 1`,
        "Spec 1: env/legacy definitions are not writable from here",
        "Refuse and explain",
      );
      mustContain(
        h.errText(),
        [...words, "--force"],
        `profile add over ${source} message`,
        "Spec 1: explains origin and that --force is required",
        "Explain where it is defined and mention --force",
        true,
      );
      ok(
        /shadow|ignored/i.test(h.errText()),
        `profile add over ${source} explains consequence`,
        "Spec 1: file profile would be shadowed or ignored",
        "message mentioning 'shadowed' or 'ignored'",
        JSON.stringify(h.errText()),
        "Say the file profile would be shadowed/ignored",
      );
      eq(
        h.upserts.length,
        0,
        `profile add over ${source}: no write`,
        "Spec 1",
        "Do not write",
      );
    },
  );

  it.each<Source>(["env-profile", "legacy-env"])(
    "name defined by %s with --force writes and warns that environment definitions take precedence",
    async (source) => {
      const h = makeHarness({
        env: ENV,
        set: mkSet([mkProfile("dev", source)]),
      });
      await runExpect(
        h,
        ["add", "dev", ...ARGS, "--no-test", "--force"],
        0,
        `profile add --force over ${source} exits 0`,
        "Spec 1: allowed only with --force",
        "Allow with --force",
      );
      eq(
        h.upserts.length,
        1,
        `profile add --force over ${source} writes once`,
        "Spec 1",
        "Save the file profile",
      );
      mustContain(
        h.outText() + h.errText(),
        ["environment", "precedence"],
        `profile add --force over ${source} warning`,
        "Spec 1: warning that environment definitions take precedence",
        "Print the warning",
        true,
      );
    },
  );
});

describe("profile add: connection check after saving (spec 1)", () => {
  it("runs the check against the profile from loadProfiles() after the write", async () => {
    const h = makeHarness({ env: ENV, set: mkSet([]) });
    await runExpect(
      h,
      ["add", "dev", ...ARGS],
      0,
      "profile add with check exits 0",
      "Spec 1",
      "Succeed",
    );
    const p = h.getters[0];
    eq(
      [h.getters.length, p?.name, p?.source, p?.apiKey, p?.endpointBaseUrl],
      [
        1,
        "dev",
        "file-profile",
        KEY,
        "https://derived-endpoint-dev.example.test",
      ],
      "profile add check uses the reloaded profile",
      "Spec 1: Profile (with derived hosts) comes from deps.loadProfiles() AFTER the write",
      "Reload profiles after saving and test that profile",
    );
    eq(
      h.gets,
      [`dev ${PROJECTS_URL}`, `dev ${OPENAPI_URL}`],
      "profile add check requests",
      "Spec 1/6: same check as `test <name>`",
      "Check projects first, then detect the release",
    );
    ok(
      /^ok\s+dev\s+api-dev\.cognigy\.ai\s+release 2026\.21\.0$/m.test(
        h.outText(),
      ),
      "profile add check result line",
      "Spec 6: `ok <name> <apiHost> release <raw>`",
      "a line matching ok  dev  api-dev.cognigy.ai  release 2026.21.0",
      JSON.stringify(h.outText()),
      "Print the same result line as `test`",
    );
  });

  it("--no-test skips the check entirely", async () => {
    const h = makeHarness({ env: ENV });
    await runExpect(
      h,
      ["add", "dev", ...ARGS, "--no-test"],
      0,
      "profile add --no-test exits 0",
      "Spec 1",
      "Succeed",
    );
    eq(
      [h.getters.length, h.gets.length],
      [0, 0],
      "profile add --no-test makes no requests",
      "Spec 1: --no-test skips the connection test",
      "Do not create a getter",
    );
  });

  it("failed check: WARNING that it was saved, still exit 0, write kept", async () => {
    const h = makeHarness({
      env: ENV,
      httpHandler: (_n, url) => {
        if (url === PROJECTS_URL)
          throw Object.assign(new Error(`denied ${KEY}`), { status: 401 });
        return { info: { version: "2026.21.0" } };
      },
    });
    await runExpect(
      h,
      ["add", "dev", ...ARGS],
      0,
      "profile add with failing check exits 0",
      "Spec 1: failed check does not fail the command",
      "Warn but succeed",
    );
    eq(
      h.upserts.length,
      1,
      "profile add with failing check keeps the write",
      "Spec 1: profile was saved",
      "Do not roll back",
    );
    mustContain(
      h.outText() + h.errText(),
      ["WARNING", "saved", "HTTP 401"],
      "profile add failing check output",
      "Spec 1: WARNING that the profile was saved but the check failed",
      "Print a WARNING including the failure reason",
    );
  });

  it("release detection failure alone is not a warning", async () => {
    const h = makeHarness({
      env: ENV,
      httpHandler: (_n, url) => {
        if (url === OPENAPI_URL) throw new Error("boom");
        return { items: [] };
      },
    });
    await runExpect(
      h,
      ["add", "dev", ...ARGS],
      0,
      "profile add with release failure exits 0",
      "Spec 6: release failure does not fail the environment",
      "Treat as ok",
    );
    mustContain(
      h.outText(),
      ["release unknown"],
      "profile add release failure line",
      "Spec 6",
      "Print `release unknown`",
    );
    eq(
      (h.outText() + h.errText()).includes("WARNING"),
      false,
      "profile add release failure has no WARNING",
      "Spec 1: only a failed check warns",
      "Do not warn",
    );
  });
});
