/**
 * Integration: the CLI wired to the REAL pure loader and the REAL store,
 * against a temp config path. Only the HTTP getter and env are fakes.
 */
import { afterEach, describe, it } from "@jest/globals";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProfileCommand } from "../profiles/profileCli.js";
import { loadProfiles } from "../profiles/profiles.js";
import { readUserProfilesFile } from "../profiles/profilesFile.js";
import {
  removeProfile,
  setDefaultProfile,
  upsertProfile,
} from "../profiles/profilesStore.js";
import { readUserConfigFile } from "../userConfigFile.js";
import { KEY, KEY_PREFIX } from "./helpers/profileCliHarness.js";
import { mustContain, mustNotContain } from "./helpers/profileCliAsserts.js";
import { eq, fail, ok } from "./helpers/specAssert.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length)
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

interface Cli {
  path: string;
  gets: string[];
  run(argv: string[]): Promise<{ code: number; out: string; err: string }>;
  json(): unknown;
  raw(): string | undefined;
}

/** Real loader + real store (linux platform, no-op runner: no icacls). */
function setup(initial?: object, env: NodeJS.ProcessEnv = {}): Cli {
  const dir = mkdtempSync(join(tmpdir(), "cognigy-cli-int-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.json");
  if (initial) writeFileSync(path, JSON.stringify(initial));
  const gets: string[] = [];
  const full = { CGKEY: KEY, ...env } as NodeJS.ProcessEnv;
  const o = {
    path,
    platform: "linux" as NodeJS.Platform,
    run: () => ({ status: 0 }),
  };
  return {
    path,
    gets,
    raw: () => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    json: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
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
          removeProfile: (n) => removeProfile(n, o),
          setDefaultProfile: (n) => setDefaultProfile(n, o),
        },
        createGetter: (profile) => ({
          async get<T = unknown>(url: string): Promise<T> {
            gets.push(`${profile.name} ${url}`);
            return (
              url.includes("openapi")
                ? { info: { version: "2026.21.0" } }
                : { items: [] }
            ) as T;
          },
        }),
      });
      if ((out + err).includes(KEY) || (out + err).includes(KEY_PREFIX))
        fail(
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

async function expectCode(
  r: Promise<{ code: number; out: string; err: string }>,
  code: number,
  what: string,
): Promise<{ out: string; err: string }> {
  const v = await r;
  eq(
    [v.code, v.out + v.err],
    [code, v.out + v.err],
    what,
    "exit code",
    `Exit ${code}; got ${v.code}; output: ${JSON.stringify(v.out + v.err)}`,
  );
  return v;
}

const A = "https://api-stg.test";
const ADD_STG = [
  "add",
  "Staging_One",
  "--api-base-url",
  A,
  "--api-key-env",
  "CGKEY",
  "--no-test",
];

describe("integration: round trip (scenario 1)", () => {
  it("add, list, show, default, remove against a fresh file", async () => {
    const c = setup();
    await expectCode(c.run(ADD_STG), 0, "add staging-one");
    eq(
      c.json(),
      { profiles: { "staging-one": { apiBaseUrl: A, apiKey: KEY } } },
      "config after add",
      "Scenario 1: exact file contents",
      "Persist the normalised name with trimmed values",
    );

    const list = await expectCode(c.run(["list"]), 0, "list after add");
    mustContain(
      list.out,
      ["staging-one", "file-profile", "api-stg.test"],
      "list after add",
      "Scenario 1",
      "Show the saved profile",
    );

    const show = await expectCode(c.run(["show", "staging-one"]), 0, "show");
    mustContain(
      show.out,
      [`API key: set (${KEY.length} characters)`],
      "show after add",
      "Scenario 1",
      "Show key length only",
    );

    await expectCode(c.run(["default", "staging-one"]), 0, "default");
    eq(
      c.json(),
      {
        defaultProfile: "staging-one",
        profiles: { "staging-one": { apiBaseUrl: A, apiKey: KEY } },
      },
      "config after default",
      "Scenario 1: default persisted",
      "Write defaultProfile",
    );

    await expectCode(c.run(["remove", "staging-one", "--yes"]), 0, "remove");
    const cfg = c.json() as { profiles?: Record<string, unknown> };
    ok(
      !("staging-one" in (cfg.profiles ?? {})),
      "config after remove",
      "Scenario 1: profile removed",
      "no staging-one",
      JSON.stringify(Object.keys(cfg.profiles ?? {})),
      "Delete the profile",
    );
    const after = await expectCode(
      c.run(["list"]),
      0,
      "list after remove (no dangling default)",
    );
    mustContain(
      after.out,
      ["no environments"],
      "list after remove",
      "Scenario 1: empty set message; removing the default must not leave a dangling pointer",
      "Clear a default that points at the removed profile",
      true,
    );
  });
});

describe("integration: shadowing (scenarios 2, 3, 5)", () => {
  const ENVDEV = {
    COGNIGY_PROFILE_DEV_API_BASE_URL: "https://api-envdev.test",
    COGNIGY_PROFILE_DEV_API_KEY: "fake-env-key-dev",
  };
  const FILE_ARGS = [
    "add",
    "dev",
    "--api-base-url",
    "https://api-file.test",
    "--api-key-env",
    "CGKEY",
  ];

  it("add over an env-defined name needs --force; with --force it saves, skips the check, env stays active", async () => {
    const c = setup(undefined, ENVDEV);
    await expectCode(c.run([...FILE_ARGS]), 1, "add dev without --force");
    eq(
      c.raw(),
      undefined,
      "no file written without --force",
      "Spec 1",
      "Do not write",
    );
    const r = await expectCode(
      c.run([...FILE_ARGS, "--force"]),
      0,
      "add dev --force",
    );
    eq(
      c.json(),
      {
        profiles: { dev: { apiBaseUrl: "https://api-file.test", apiKey: KEY } },
      },
      "config after add --force",
      "Scenario 2: file profile saved",
      "Write the profile",
    );
    eq(
      c.gets,
      [],
      "no connection check for a shadowed profile",
      "Change A",
      "Skip the check",
    );
    mustContain(
      r.out + r.err,
      ["skipped", "environment variables"],
      "skip note",
      "Change A",
      "Explain the skipped check",
      true,
    );
    const list = await expectCode(c.run(["list"]), 0, "list");
    const line =
      list.out.split(/\r?\n/).find((l) => l.includes("api-envdev.test")) ?? "";
    mustContain(
      line,
      ["dev", "env-profile"],
      "list shows the env profile as active",
      "Scenario 2",
      "Show env precedence",
    );
    mustNotContain(
      list.out,
      ["api-file.test"],
      "list hides the shadowed file profile",
      "Scenario 2",
      "Only the active definition is listed",
    );
  });

  const LEGACY = {
    COGNIGY_API_BASE_URL: "https://api-legacy.test",
    COGNIGY_API_KEY: "fake-legacy-key",
  };
  it("add default over legacy-file needs --force; afterwards list shows file-profile and legacy keys remain", async () => {
    const c = setup(LEGACY);
    const before = c.raw();
    const first = await expectCode(c.run(["list"]), 0, "list legacy");
    mustContain(
      first.out,
      ["legacy-file"],
      "list before",
      "Scenario 3",
      "Show the legacy source",
    );
    const args = [
      "add",
      "default",
      "--api-base-url",
      "https://api-new.test",
      "--api-key-env",
      "CGKEY",
      "--no-test",
    ];
    await expectCode(c.run(args), 1, "add default without --force");
    eq(
      c.raw(),
      before,
      "file untouched without --force",
      "Scenario 3",
      "Do not write",
    );
    await expectCode(c.run([...args, "--force"]), 0, "add default --force");
    const list = await expectCode(c.run(["list"]), 0, "list after");
    const line =
      list.out.split(/\r?\n/).find((l) => l.includes("api-new.test")) ?? "";
    mustContain(
      line,
      ["file-profile"],
      "list after --force shows the file profile",
      "Scenario 3",
      "Replaced as file-profile",
    );
    mustNotContain(
      list.out,
      ["legacy-file", "api-legacy.test"],
      "legacy no longer active",
      "Scenario 3",
      "Replace the legacy entry",
    );
    eq(
      c.json(),
      {
        ...LEGACY,
        profiles: {
          default: { apiBaseUrl: "https://api-new.test", apiKey: KEY },
        },
      },
      "config keeps the legacy flat keys",
      "Scenario 3/6: flat keys untouched",
      "Do not remove legacy keys",
    );
  });

  it("remove and default refuse env/legacy sources and leave the file alone", async () => {
    const c = setup(LEGACY, ENVDEV);
    const before = c.raw();
    const rmEnv = await expectCode(
      c.run(["remove", "dev", "--yes"]),
      1,
      "remove env profile",
    );
    mustContain(
      rmEnv.err,
      ["environment variables"],
      "remove env message",
      "Spec 4",
      "Explain origin",
      true,
    );
    const rmLeg = await expectCode(
      c.run(["remove", "default", "--yes"]),
      1,
      "remove legacy profile",
    );
    mustContain(
      rmLeg.err,
      ["legacy"],
      "remove legacy message",
      "Spec 4",
      "Explain origin",
      true,
    );
    const dEnv = await expectCode(
      c.run(["default", "dev"]),
      1,
      "default env profile",
    );
    mustContain(
      dEnv.err,
      ["COGNIGY_PROFILE", "dev"],
      "default env message",
      "Spec 5",
      "Point at COGNIGY_PROFILE",
    );
    await expectCode(
      c.run(["default", "default"]),
      1,
      "default legacy profile",
    );
    eq(c.raw(), before, "file unchanged by refusals", "Specs 4/5", "No writes");
  });
});

describe("integration: bad default pointer (scenario 4)", () => {
  it("list/show/test report a hint (exit 1); default --clear fixes it", async () => {
    const alpha = {
      apiBaseUrl: "https://alpha.test",
      apiKey: "fake-key-alpha",
    };
    const c = setup({ defaultProfile: "missing-one", profiles: { alpha } });
    for (const argv of [
      ["list"],
      ["show", "alpha"],
      ["test"],
      ["test", "--all"],
    ]) {
      const r = await expectCode(c.run(argv), 1, `profile ${argv.join(" ")}`);
      mustContain(
        r.out + r.err,
        ["cognigy-setup profile default --clear", "COGNIGY_PROFILE"],
        `profile ${argv.join(" ")} hint`,
        "Change C",
        "Print the fix hints",
      );
    }
    await expectCode(c.run(["default", "--clear"]), 0, "default --clear");
    eq(
      c.json(),
      { profiles: { alpha } },
      "config after --clear",
      "Change C",
      "Remove only the pointer",
    );
    const list = await expectCode(c.run(["list"]), 0, "list after fix");
    mustContain(
      list.out,
      ["alpha"],
      "list after fix",
      "Change C",
      "The CLI works again",
    );
  });
});

describe("integration: add preserves everything else (scenario 6)", () => {
  it("add --no-test keeps legacy keys, earlier profiles and unknown keys", async () => {
    const original = {
      COGNIGY_API_BASE_URL: "https://api-legacy.test",
      COGNIGY_API_KEY: "fake-legacy-key",
      defaultProfile: "dev",
      profiles: {
        dev: { apiBaseUrl: "https://api-dev.test", apiKey: "fake-key-dev" },
      },
      unknownObj: { a: [1, { b: 2 }] },
      unknownNum: 7,
    };
    const c = setup(original);
    await expectCode(
      c.run([
        "add",
        "newone",
        "--api-base-url",
        A,
        "--api-key-env",
        "CGKEY",
        "--no-test",
      ]),
      0,
      "add newone",
    );
    eq(
      c.json(),
      {
        ...original,
        profiles: {
          ...original.profiles,
          newone: { apiBaseUrl: A, apiKey: KEY },
        },
      },
      "config after add preserves everything",
      "Scenario 6: exactly the expected file",
      "Merge the new profile; leave all other content untouched",
    );
    eq(c.gets, [], "--no-test makes no requests", "Spec 1", "No check");
  });
});
