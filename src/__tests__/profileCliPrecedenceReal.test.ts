/**
 * CLI-level regression for precedence defects 2 and 3: the CLI wired to the REAL
 * pure loader and REAL file readers against a temp config path. Only the HTTP
 * getter (which records the profile it was created for) and env are fakes.
 */
import { afterEach, describe, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProfileCommand } from "../profiles/profileCli.js";
import { loadProfiles } from "../profiles/profiles.js";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import { readUserConfigFile } from "../userConfigFile.js";
import { mustContain, mustNotContain } from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length)
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

const FILE_KEY = "fake-key-file-aaaa";
const ENV_KEY = "fake-key-env-bbbb";
const P = "COGNIGY_PROFILE_";
const FILE_PROD_URL = "https://api-prod-file.cognigy.ai";
const ENV_PROD_URL = "https://api-prod-env.cognigy.ai";
const DEV = {
  apiBaseUrl: "https://api-dev.cognigy.ai",
  apiKey: "fake-key-dev",
};

interface Created {
  name: string;
  source: string;
}
interface Cli {
  path: string;
  created: Created[];
  run(argv: string[]): Promise<{ code: number; out: string; err: string }>;
}

function setup(rawFile: unknown, env: NodeJS.ProcessEnv): Cli {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-cli-prec-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(rawFile));
  const created: Created[] = [];
  return {
    path,
    created,
    async run(argv) {
      let out = "";
      let err = "";
      const code = await runProfileCommand(argv, {
        out: (t) => void (out += t),
        err: (t) => void (err += t),
        isTTY: false,
        ask: async () => {
          throw new Error("test: unexpected prompt");
        },
        askHidden: async () => {
          throw new Error("test: unexpected hidden prompt");
        },
        env,
        configPath: path,
        loadProfiles: () =>
          loadProfiles({
            env,
            legacyFile: readUserConfigFile(path),
            fileProfiles: readUserProfilesFile(path),
          }),
        store: {
          upsertProfile: () => {
            throw new Error("test: store must not be used");
          },
          removeProfile: () => {
            throw new Error("test: store must not be used");
          },
          setDefaultProfile: () => {
            throw new Error("test: store must not be used");
          },
        },
        createGetter: (profile) => {
          created.push({ name: profile.name, source: profile.source });
          return {
            async get<T = unknown>(url: string): Promise<T> {
              return (
                url.includes("openapi")
                  ? { info: { version: "2026.21.0" } }
                  : { items: [] }
              ) as T;
            },
          };
        },
      });
      for (const k of [FILE_KEY, ENV_KEY, DEV.apiKey])
        ok(
          !(out + err).includes(k),
          `profile ${argv.join(" ")}`,
          "Spec 0: no key in out/err",
          "no key material",
          "key material in out/err [redacted]",
          "Never print keys",
        );
      return { code, out, err };
    },
  };
}

/** Reason the real loader gives for `name` from the file alone (no env). */
function fileOnlyReason(path: string, name: string): string {
  const set = loadProfiles({
    env: {},
    legacyFile: readUserConfigFile(path),
    fileProfiles: readUserProfilesFile(path),
  });
  const reason = set.problems.find((p) => p.name === name)?.reason;
  if (!reason) throw new Error(`test setup: no file problem for ${name}`);
  return reason;
}

async function expectExit(
  c: Cli,
  argv: string[],
  code: number,
  why: string,
): Promise<{ out: string; err: string }> {
  const r = await c.run(argv);
  eq(
    [r.code, r.out + r.err],
    [code, r.out + r.err],
    `profile ${argv.join(" ")}`,
    why,
    `Exit ${code}; got ${r.code}; output: ${JSON.stringify(r.out + r.err)}`,
  );
  return r;
}

describe("scenario 1: unusable env definition hides the saved profile of the same name", () => {
  const ENV_BROKEN = { [`${P}PROD_API_BASE_URL`]: ENV_PROD_URL };
  const file = {
    profiles: {
      prod: { apiBaseUrl: FILE_PROD_URL, apiKey: FILE_KEY },
      dev: DEV,
    },
  };
  const reasonOf = (c: Cli): string => {
    const set = loadProfiles({
      env: ENV_BROKEN,
      legacyFile: readUserConfigFile(c.path),
      fileProfiles: readUserProfilesFile(c.path),
    });
    return set.problems.find((p) => p.name === "prod")?.reason ?? "";
  };

  it("test --all creates no getter for prod", async () => {
    const c = setup(file, ENV_BROKEN);
    await c.run(["test", "--all"]);
    eq(
      c.created,
      [{ name: "dev", source: "file-profile" }],
      "profile test --all",
      "Defect 2: the saved prod must not be tested while its env definition is unusable",
      "Test only usable profiles; skip names whose winning definition failed",
    );
  });

  it.each([["test"], ["show"]])(
    "%s prod exits 1 with the reason and creates no getter",
    async (verb) => {
      const c = setup(file, ENV_BROKEN);
      const reason = reasonOf(c);
      ok(
        reason.length > 0,
        "test setup",
        "the env-only definition must be reported as a problem",
        "a non-empty reason",
        "empty",
        "n/a",
      );
      const r = await expectExit(
        c,
        [verb, "prod"],
        1,
        "Defect 2: prod is rejected because its env definition is unusable",
      );
      mustContain(
        r.out + r.err,
        [reason],
        `profile ${verb} prod`,
        "Defect 2: the env reason is reported",
        "Print the unusable reason",
      );
      eq(
        c.created,
        [],
        `profile ${verb} prod getters`,
        "Defect 2: no request is made for a rejected profile",
        "Do not create a connection for prod",
      );
    },
  );
});

describe("scenarios 2 and 3: a broken saved entry must not block a valid env profile", () => {
  const ENV_PROD_OK = {
    [`${P}PROD_API_BASE_URL`]: ENV_PROD_URL,
    [`${P}PROD_API_KEY`]: ENV_KEY,
  } as NodeJS.ProcessEnv;

  it.each([
    [
      "scenario 2 (apiKey of the wrong type in the file)",
      {
        profiles: {
          prod: { apiBaseUrl: FILE_PROD_URL, apiKey: 123 },
          dev: DEV,
        },
      },
    ],
    [
      "scenario 3 (invalid URL in the file)",
      {
        profiles: {
          prod: { apiBaseUrl: "not a url", apiKey: FILE_KEY },
          dev: DEV,
        },
      },
    ],
  ])("%s", async (label, raw) => {
    const c = setup(raw, ENV_PROD_OK);
    const reason = fileOnlyReason(c.path, "prod");

    const show = await expectExit(
      c,
      ["show", "prod"],
      0,
      `${label}: the valid env profile is shown`,
    );
    mustContain(
      show.out,
      ["prod", "api-prod-env.cognigy.ai"],
      `profile show prod (${label})`,
      "Defect 3: show reports the env profile",
      "Show the winning definition",
    );
    mustNotContain(
      show.out + show.err,
      [reason],
      `profile show prod (${label})`,
      "Defect 3: the shadowed file problem is not reported",
      "Drop problems of lower-precedence sources",
    );

    const t = await expectExit(
      c,
      ["test", "prod"],
      0,
      `${label}: the env profile is tested`,
    );
    eq(
      c.created,
      [{ name: "prod", source: "env-profile" }],
      `profile test prod (${label})`,
      "Defect 3: the check runs against the env-profile",
      "Create the connection for the winning env-profile",
    );
    ok(
      t.out.split(/\r?\n/).some((l) => /\bok\b/i.test(l) && l.includes("prod")),
      `profile test prod (${label})`,
      "Defect 3: an ok line for prod",
      "an output line containing both 'ok' and 'prod'",
      JSON.stringify(t.out),
      "Print a passing result for prod",
    );

    const list = await expectExit(c, ["list"], 0, `${label}: list works`);
    const prodLines = list.out.split(/\r?\n/).filter((l) => l.includes("prod"));
    ok(
      prodLines.length === 1 && prodLines[0].includes("env-profile"),
      `profile list (${label})`,
      "Defect 3: prod appears once, as env-profile",
      "exactly one line with 'prod' and it contains 'env-profile'",
      JSON.stringify(prodLines),
      "List the winning definition only",
    );
    mustNotContain(
      list.out + list.err,
      [reason],
      `profile list (${label})`,
      "Defect 3: list does not report a problem for prod",
      "Drop problems of lower-precedence sources",
    );
  });
});
