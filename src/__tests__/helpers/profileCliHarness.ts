import { jest } from "@jest/globals";
import {
  runProfileCommand,
  type ProfileCliDeps,
} from "../../profiles/profileCli.js";
import type { Profile, ProfileSet } from "../../profiles/profiles.js";
import { fail, msg } from "./specAssert.js";

/** Distinctive fake secret; must never reach out/err for ANY command. */
export const KEY = "zQ9xK2mWvB7tLpR4";
export const KEY_PREFIX = KEY.slice(0, 6);
export const CONFIG_PATH = "C:\\fake-temp-dir\\cfg\\config.json";
export const PROJECTS_URL = "/v2.0/projects?limit=1";
export const OPENAPI_URL = "/openapi/openapi-viewer.json";

export type Source =
  | "legacy-env"
  | "legacy-file"
  | "env-profile"
  | "file-profile";

export interface ProfileOverrides {
  apiBaseUrl?: string;
  endpointBaseUrl?: string;
  webchatBaseUrl?: string;
  staticFilesBaseUrl?: string;
  versionHint?: string;
  apiKey?: string;
}

/** Builds a frozen Profile (apiKey non-enumerable like the engine's). */
export function mkProfile(
  name: string,
  source: Source = "file-profile",
  o: ProfileOverrides = {},
): Profile {
  const p: Record<string, unknown> = {
    name,
    apiBaseUrl: o.apiBaseUrl ?? `https://api-${name}.cognigy.ai`,
    endpointBaseUrl: o.endpointBaseUrl ?? `https://endpoint-${name}.cognigy.ai`,
    webchatBaseUrl: o.webchatBaseUrl ?? `https://webchat-${name}.cognigy.ai`,
    staticFilesBaseUrl:
      o.staticFilesBaseUrl ?? `https://static-${name}.cognigy.ai`,
    source,
  };
  if (o.versionHint !== undefined) p.versionHint = o.versionHint;
  Object.defineProperty(p, "apiKey", {
    value: o.apiKey ?? KEY,
    enumerable: false,
  });
  return Object.freeze(p) as unknown as Profile;
}

export function mkSet(
  profiles: Profile[],
  defaultName?: string,
  problems: { name: string; reason: string }[] = [],
): ProfileSet {
  return Object.freeze({
    profiles: Object.freeze([...profiles]),
    defaultName,
    problems: Object.freeze(problems.map((x) => Object.freeze({ ...x }))),
  }) as unknown as ProfileSet;
}

export interface UpsertCall {
  name: string;
  profile: Record<string, unknown>;
  options: { path?: string } | undefined;
}

export interface HarnessOptions {
  set?: ProfileSet;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  configPath?: string | undefined;
  asks?: string[];
  hiddenAsks?: string[];
  removeResult?: boolean;
  /** Per-profile-name handler for HTTP GETs; default serves a healthy env. */
  httpHandler?: (profileName: string, url: string) => unknown;
  /** deps.loadProfiles() throws this (e.g. a ProfileConfigError). */
  loadThrows?: Error;
  /** Overall per-environment check deadline (optional dep). */
  checkTimeoutMs?: number;
}

export interface Harness {
  deps: ProfileCliDeps;
  outText(): string;
  errText(): string;
  upserts: UpsertCall[];
  removes: { name: string; options: { path?: string } | undefined }[];
  defaults: {
    name: string | undefined;
    options: { path?: string } | undefined;
  }[];
  /** Every createGetter(profile) in order: the Profile object received. */
  getters: Profile[];
  /** Every GET in order, as "<profileName> <url>". */
  gets: string[];
  asked: string[];
  askedHidden: string[];
  loadCalls(): number;
  run(argv: string[]): Promise<number>;
}

/** Node runtime warnings (not produced by the code under test) are ignored. */
const NODE_NOISE =
  /\((node|Use `node --trace-warnings)|ExperimentalWarning|DeprecationWarning|--trace-warnings/;

function leakCheck(what: string, text: string): void {
  if (text.includes(KEY) || text.includes(KEY_PREFIX)) {
    fail(
      what,
      "Spec 0: no API key (or any part of it) may appear in out/err for any command",
      "out/err free of the key and its first characters",
      "the key (or a prefix of it) was written to out/err [redacted here]",
      "Never print key material; report only its length where specified",
    );
  }
}

/**
 * Builds injected deps (all fakes, no real I/O). run() executes the command
 * under spies proving process.exit / process.stdout / process.stderr /
 * console were never used, then applies the secret-leak guard to out+err.
 */
export function makeHarness(opts: HarnessOptions = {}): Harness {
  const outs: string[] = [];
  const errs: string[] = [];
  const upserts: UpsertCall[] = [];
  const removes: Harness["removes"] = [];
  const defaults: Harness["defaults"] = [];
  const getters: Profile[] = [];
  const gets: string[] = [];
  const asked: string[] = [];
  const askedHidden: string[] = [];
  const asks = [...(opts.asks ?? [])];
  const hiddenAsks = [...(opts.hiddenAsks ?? [])];
  const base = opts.set ?? mkSet([]);
  let loads = 0;

  const handler =
    opts.httpHandler ??
    ((_n: string, url: string): unknown =>
      url === OPENAPI_URL ? { info: { version: "2026.21.0" } } : { items: [] });

  const deps: ProfileCliDeps = {
    out: (t) => void outs.push(t),
    err: (t) => void errs.push(t),
    isTTY: opts.isTTY ?? false,
    ask: async (q) => {
      asked.push(q);
      const a = asks.shift();
      if (a === undefined) throw new Error("test: unexpected visible prompt");
      return a;
    },
    askHidden: async (q) => {
      askedHidden.push(q);
      const a = hiddenAsks.shift();
      if (a === undefined) throw new Error("test: unexpected hidden prompt");
      return a;
    },
    env: opts.env ?? {},
    configPath: "configPath" in opts ? opts.configPath : CONFIG_PATH,
    loadProfiles: () => {
      loads++;
      if (opts.loadThrows) throw opts.loadThrows;
      if (upserts.length === 0) return base;
      // After a write the "system" now contains the saved profiles, with hosts
      // derived by the (fake) engine: distinctive endpoint/webchat/static hosts.
      const saved = upserts.map((u) =>
        mkProfile(u.name, "file-profile", {
          apiBaseUrl: u.profile.apiBaseUrl as string,
          apiKey: u.profile.apiKey as string,
          endpointBaseUrl: `https://derived-endpoint-${u.name}.example.test`,
          webchatBaseUrl: `https://derived-webchat-${u.name}.example.test`,
          staticFilesBaseUrl: `https://derived-static-${u.name}.example.test`,
          ...(u.profile.versionHint !== undefined
            ? { versionHint: u.profile.versionHint as string }
            : {}),
        }),
      );
      // Real precedence: env-profile / legacy-env definitions of the same name
      // win over a saved file profile; a legacy-file entry is replaced by it.
      const shadowed = new Set(
        base.profiles
          .filter(
            (p) => p.source === "env-profile" || p.source === "legacy-env",
          )
          .map((p) => p.name),
      );
      const effective = saved.filter((s) => !shadowed.has(s.name));
      const savedNames = new Set(effective.map((s) => s.name));
      return mkSet(
        [...base.profiles.filter((p) => !savedNames.has(p.name)), ...effective],
        base.defaultName,
        [...base.problems],
      );
    },
    store: {
      upsertProfile: (name, profile, options) => {
        const existing = base.profiles.some(
          (p) => p.name === name && p.source === "file-profile",
        );
        upserts.push({
          name,
          profile: { ...profile },
          options: options && { ...options },
        });
        return { created: !existing };
      },
      removeProfile: (name, options) => {
        removes.push({ name, options: options && { ...options } });
        return opts.removeResult ?? true;
      },
      setDefaultProfile: (name, options) => {
        defaults.push({ name, options: options && { ...options } });
      },
    },
    createGetter: (profile) => {
      getters.push(profile);
      return {
        async get<T = unknown>(url: string): Promise<T> {
          gets.push(`${profile.name} ${url}`);
          return (await handler(profile.name, url)) as T;
        },
      };
    },
  };

  if (opts.checkTimeoutMs !== undefined) {
    (deps as ProfileCliDeps & { checkTimeoutMs?: number }).checkTimeoutMs =
      opts.checkTimeoutMs;
  }

  return {
    deps,
    outText: () => outs.join(""),
    errText: () => errs.join(""),
    upserts,
    removes,
    defaults,
    getters,
    gets,
    asked,
    askedHidden,
    loadCalls: () => loads,
    async run(argv: string[]): Promise<number> {
      const exit = jest.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit must not be called");
      }) as never);
      const so = jest
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const se = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const cons = (["log", "info", "warn", "error", "debug"] as const).map(
        (m) => jest.spyOn(console, m).mockImplementation(() => undefined),
      );
      let code: number;
      let direct = 0;
      try {
        code = await runProfileCommand(argv, deps);
      } finally {
        const real = (calls: unknown[][]): number =>
          calls.filter((c) => !NODE_NOISE.test(String(c[0]))).length;
        direct =
          exit.mock.calls.length +
          real(so.mock.calls as unknown[][]) +
          real(se.mock.calls as unknown[][]) +
          cons.reduce((n, s) => n + real(s.mock.calls as unknown[][]), 0);
        exit.mockRestore();
        so.mockRestore();
        se.mockRestore();
        cons.forEach((s) => s.mockRestore());
      }
      if (direct !== 0) {
        fail(
          `profile ${argv.join(" ")}`,
          "Spec 8: CLI must write only via deps.out/deps.err and never call process.exit/stdout/stderr/console",
          "0 direct process/console uses",
          `${direct} direct uses`,
          "Route all output through the injected writers and return the exit code",
        );
      }
      leakCheck(`profile ${argv.join(" ")} (stdout)`, outs.join(""));
      leakCheck(`profile ${argv.join(" ")} (stderr)`, errs.join(""));
      return code;
    },
  };
}

/** Standard failure text for exit-code assertions. */
export function codeMsg(
  what: string,
  why: string,
  expected: number,
  actual: number,
  h: Harness,
  guidance: string,
): string {
  return msg(
    what,
    why,
    `exit code ${expected}`,
    `exit code ${actual}; out=${JSON.stringify(h.outText())} err=${JSON.stringify(h.errText())}`,
    guidance,
  );
}
