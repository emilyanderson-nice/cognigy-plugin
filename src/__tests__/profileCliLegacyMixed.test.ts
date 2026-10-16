/**
 * Defect A at CLI level: the CLI wired to the REAL pure loader and REAL store
 * against a temp config path. `profile add default` over a MIXED legacy default
 * (one COGNIGY_API_* value from env, the other from the config file) must be
 * treated like legacy-env: refused without --force, warning when forced.
 */
import { afterEach, describe, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProfileCommand } from "../profiles/profileCli.js";
import { loadProfiles } from "../profiles/profiles.js";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import { upsertProfile } from "../profiles/profilesStore.js";
import { readUserConfigFile } from "../userConfigFile.js";
import { KEY } from "./helpers/profileCliHarness.js";
import { mustContain } from "./helpers/profileCliAsserts.js";
import { eq, ok } from "./helpers/specAssert.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length)
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

const ENV_URL = "https://api-mixed-env.test";
const FILE_KEY = "fake-key-file-mixed";

function setup(env: NodeJS.ProcessEnv, initial: object) {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-cli-mixed-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(initial));
  const full = { CGKEY: KEY, ...env } as NodeJS.ProcessEnv;
  const o = {
    path,
    platform: "linux" as NodeJS.Platform,
    run: () => ({ status: 0 }),
  };
  return {
    raw: (): string => readFileSync(path, "utf8"),
    async run(argv: string[]) {
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
        env: full,
        configPath: path,
        loadProfiles: () =>
          loadProfiles({
            env: full,
            legacyFile: readUserConfigFile(path),
            fileProfiles: readUserProfilesFile(path),
          }),
        store: {
          upsertProfile: (n, p) => upsertProfile(n, p, o),
          removeProfile: () => {
            throw new Error("test: remove not expected");
          },
          setDefaultProfile: () => {
            throw new Error("test: set default not expected");
          },
        },
        createGetter: () => ({
          async get<T = unknown>(): Promise<T> {
            throw new Error("test: no request expected");
          },
        }),
      });
      return { code, out, err };
    },
  };
}

const ADD = [
  "add",
  "default",
  "--api-base-url",
  "https://api-new.test",
  "--api-key-env",
  "CGKEY",
  "--no-test",
];

describe("profile add default over a mixed legacy default is treated like legacy-env", () => {
  const MIXED_ENV = { COGNIGY_API_BASE_URL: ENV_URL };
  const FILE = { COGNIGY_API_KEY: FILE_KEY };

  it("list reports the mixed default with source legacy-env", async () => {
    const c = setup(MIXED_ENV, FILE);
    const r = await c.run(["list"]);
    const line =
      r.out.split(/\r?\n/).find((l) => l.includes("api-mixed-env.test")) ?? "";
    mustContain(
      line,
      ["legacy-env"],
      "profile list (mixed legacy default)",
      "Defect A: any env-supplied field makes the source legacy-env",
      "Show legacy-env for the mixed definition",
    );
    ok(
      !line.includes("legacy-file"),
      "profile list (mixed legacy default)",
      "Defect A: the mixed definition is not legacy-file",
      "no legacy-file on the default line",
      JSON.stringify(line),
      "Show only legacy-env",
    );
  });

  it("without --force: exit 1, explains environment variables, file untouched", async () => {
    const c = setup(MIXED_ENV, FILE);
    const before = c.raw();
    const r = await c.run(ADD);
    eq(
      r.code,
      1,
      "profile add default over mixed legacy (no --force)",
      "Defect A: a saved default would be ignored because of the environment variable, so --force is required",
      "Exit 1 and refuse to write",
    );
    mustContain(
      r.err,
      ["environment variables", "--force"],
      "profile add default over mixed legacy message",
      "Defect A: explains the environment origin and --force",
      "Say it is defined by environment variables and mention --force",
      true,
    );
    eq(
      c.raw(),
      before,
      "profile add default over mixed legacy: file",
      "Defect A: no write without --force",
      "Do not touch the config file",
    );
  });

  it("with --force: exit 0, saved, warns that environment definitions take precedence", async () => {
    const c = setup(MIXED_ENV, FILE);
    const r = await c.run([...ADD, "--force"]);
    eq(
      r.code,
      0,
      "profile add default --force over mixed legacy",
      "Defect A: allowed with --force",
      "Exit 0",
    );
    mustContain(
      r.out + r.err,
      ["environment", "precedence"],
      "profile add default --force over mixed legacy warning",
      "Defect A: warn that environment definitions take precedence",
      "Print the precedence warning",
      true,
    );
    const saved = JSON.parse(c.raw()) as {
      profiles?: { default?: { apiBaseUrl: string } };
    };
    eq(
      saved.profiles?.default?.apiBaseUrl,
      "https://api-new.test",
      "profile add default --force over mixed legacy: saved profile",
      "Defect A: the profile is still written",
      "Persist the saved default",
    );
  });
});
