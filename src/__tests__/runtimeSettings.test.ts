import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { eq, ok } from "./helpers/specAssert.js";

// Never touch the real ~/.cognigy-plugin, even if an implementation tried to.
jest.unstable_mockModule("../userConfigFile.js", () => ({
  readUserConfigFile: jest.fn<() => Record<string, string>>(() => ({})),
  writeUserConfigFile: jest.fn(),
  USER_CONFIG_FILE: "/fake/.cognigy-plugin/config.json",
  USER_CONFIG_DIR: "/fake/.cognigy-plugin",
}));

const { loadRuntimeSettings } = await import("../runtimeSettings.js");
const { loadConfig } = await import("../config.js");

const FAKE_CREDS = {
  COGNIGY_API_BASE_URL: "https://api-dev.cognigy.ai",
  COGNIGY_API_KEY: "fake-key-aaaa",
};
type Env = Record<string, string>;

/** Every env var either loader may read; cleared around each parity run. */
const TOUCHED = [
  "COGNIGY_API_BASE_URL",
  "COGNIGY_API_KEY",
  "COGNIGY_ENDPOINT_BASE_URL",
  "COGNIGY_WEBCHAT_BASE_URL",
  "COGNIGY_STATIC_FILES_BASE_URL",
  "MCP_SERVER_NAME",
  "MCP_SERVER_VERSION",
  "LOG_LEVEL",
  "COGNIGY_DISABLE_AUDIT_ATTRIBUTION",
  "RATE_LIMIT_MAX_REQUESTS",
  "RATE_LIMIT_WINDOW_MS",
];

function withProcessEnv<T>(env: Env, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of TOUCHED) saved[k] = process.env[k];
  try {
    for (const k of TOUCHED) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** The non-credential fields loadConfig also reports. */
function settingsFieldsOf(c: ReturnType<typeof loadConfig>) {
  return {
    serverName: c.serverName,
    serverVersion: c.serverVersion,
    logLevel: c.logLevel,
    auditAttribution: c.auditAttribution,
    rateLimit: c.rateLimit,
  };
}

let errSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});
const errLines = (): string[] =>
  errSpy.mock.calls.map((c: unknown[]) => String(c[0]));

describe("loadRuntimeSettings defaults", () => {
  it("returns exact defaults for an empty env without throwing and without credentials", () => {
    const what = "loadRuntimeSettings({}) defaults";
    const why = "RS-1: settings never need credentials and never throw";
    let result: unknown;
    try {
      result = loadRuntimeSettings({});
    } catch (e) {
      ok(
        false,
        what,
        why,
        "returns settings",
        `threw ${(e as Error).message}`,
        "Return defaults for an environment with no credentials.",
      );
    }
    const pkgVersion = withProcessEnv(FAKE_CREDS, () =>
      loadConfig(),
    ).serverVersion;
    eq(
      result,
      {
        serverName: "cognigy-api-mcp",
        serverVersion: pkgVersion,
        logLevel: "info",
        auditAttribution: true,
        rateLimit: { maxRequests: 100, windowMs: 60000 },
      },
      what,
      "RS-1: defaults are cognigy-api-mcp / package version / info / audit on / 100 per 60000ms",
      "Produce exactly these defaults when nothing is set.",
    );
    eq(
      errLines(),
      [],
      what,
      "RS-1: defaults emit no diagnostics",
      "Write nothing to stderr when every value is default.",
    );
  });

  it("does not read process.env when an explicit env is passed", () => {
    const saved = process.env.MCP_SERVER_NAME;
    process.env.MCP_SERVER_NAME = "from-process-env";
    try {
      eq(
        loadRuntimeSettings({}).serverName,
        "cognigy-api-mcp",
        "explicit env isolation",
        "RS-2: the env argument fully replaces process.env",
        "Only consult the env passed in when one is given.",
      );
    } finally {
      if (saved === undefined) delete process.env.MCP_SERVER_NAME;
      else process.env.MCP_SERVER_NAME = saved;
    }
  });

  it("reads process.env when no argument is given", () => {
    const actual = withProcessEnv({ MCP_SERVER_NAME: "ambient-name" }, () =>
      loadRuntimeSettings(),
    );
    eq(
      actual.serverName,
      "ambient-name",
      "default env argument",
      "RS-2: env defaults to process.env",
      "Fall back to the process environment when called without arguments.",
    );
  });
});

describe("loadRuntimeSettings fields", () => {
  it("uses MCP_SERVER_NAME and MCP_SERVER_VERSION verbatim", () => {
    const s = loadRuntimeSettings({
      MCP_SERVER_NAME: "my-server",
      MCP_SERVER_VERSION: "9.8.7",
    });
    eq(
      [s.serverName, s.serverVersion],
      ["my-server", "9.8.7"],
      "custom name/version",
      "RS-3: env overrides name and version",
      "Honour MCP_SERVER_NAME and MCP_SERVER_VERSION exactly.",
    );
  });

  it.each(["debug", "info", "warn", "error"] as const)(
    "accepts LOG_LEVEL=%s silently",
    (level) => {
      eq(
        loadRuntimeSettings({ LOG_LEVEL: level }).logLevel,
        level,
        `LOG_LEVEL=${level}`,
        "RS-4: valid levels pass through",
        "Return the level as given.",
      );
      eq(
        errLines(),
        [],
        `LOG_LEVEL=${level}`,
        "RS-4: valid level emits no diagnostic",
        "Stay silent for valid levels.",
      );
    },
  );

  it.each(["verbose", "trace", "warning"])(
    "falls back to info with exactly one diagnostic for LOG_LEVEL=%j",
    (bad) => {
      const s = loadRuntimeSettings({ LOG_LEVEL: bad });
      eq(
        s.logLevel,
        "info",
        `invalid LOG_LEVEL ${JSON.stringify(bad)}`,
        "RS-4: invalid level becomes info",
        "Fall back to info.",
      );
      const lines = errLines();
      ok(
        lines.length === 1 && lines[0].startsWith("[config] Invalid LOG_LEVEL"),
        `invalid LOG_LEVEL ${JSON.stringify(bad)} diagnostic`,
        "RS-4: exactly one console.error line starting '[config] Invalid LOG_LEVEL'",
        "1 line starting '[config] Invalid LOG_LEVEL'",
        `${lines.length} lines: ${JSON.stringify(lines)}`,
        "Report an invalid level once on stderr with that prefix.",
      );
    },
  );

  it.each(["1", "true", "TRUE", "yes", "Yes", " yes ", "  1\t", " True "])(
    "disables audit attribution for COGNIGY_DISABLE_AUDIT_ATTRIBUTION=%j",
    (v) => {
      eq(
        loadRuntimeSettings({ COGNIGY_DISABLE_AUDIT_ATTRIBUTION: v })
          .auditAttribution,
        false,
        `audit opt-out ${JSON.stringify(v)}`,
        "RS-5: 1/true/yes (trimmed, any case) opt out",
        "Treat those spellings as opt-out.",
      );
    },
  );

  it.each(["false", "0", "no", "", "off", "2"])(
    "keeps audit attribution on for COGNIGY_DISABLE_AUDIT_ATTRIBUTION=%j",
    (v) => {
      eq(
        loadRuntimeSettings({ COGNIGY_DISABLE_AUDIT_ATTRIBUTION: v })
          .auditAttribution,
        true,
        `audit non-opt-out ${JSON.stringify(v)}`,
        "RS-5: only 1/true/yes opt out",
        "Leave attribution enabled for any other value.",
      );
    },
  );

  it("parses custom integer rate limits exactly", () => {
    eq(
      loadRuntimeSettings({
        RATE_LIMIT_MAX_REQUESTS: "50",
        RATE_LIMIT_WINDOW_MS: "1500",
      }).rateLimit,
      { maxRequests: 50, windowMs: 1500 },
      "custom rate limits",
      "RS-6: integers are used as given",
      "Parse both values as integers.",
    );
  });

  it.each([
    ["RATE_LIMIT_MAX_REQUESTS", "abc", { maxRequests: 100, windowMs: 60000 }],
    ["RATE_LIMIT_WINDOW_MS", "abc", { maxRequests: 100, windowMs: 60000 }],
  ])(
    "%s=%j falls back to the default with exactly one diagnostic",
    (key, bad, expected) => {
      const s = loadRuntimeSettings({ [key]: bad });
      eq(
        s.rateLimit,
        expected,
        `${key}=${bad}`,
        "RS-6: non-integer falls back to the default",
        "Use the default when the value is not an integer.",
      );
      const lines = errLines();
      ok(
        lines.length === 1 && lines[0].startsWith("[config] Invalid integer"),
        `${key}=${bad} diagnostic`,
        "RS-6: exactly one console.error line starting '[config] Invalid integer'",
        "1 line starting '[config] Invalid integer'",
        `${lines.length} lines: ${JSON.stringify(lines)}`,
        "Report a bad integer once on stderr with that prefix.",
      );
    },
  );

  it("never reflects credential values in any field or diagnostic", () => {
    const s = loadRuntimeSettings({
      ...FAKE_CREDS,
      LOG_LEVEL: "nope",
    });
    const dump = JSON.stringify(s) + errLines().join("\n");
    ok(
      !dump.includes("fake-key-aaaa"),
      "credential secrecy",
      "RS-1: settings never read an API key",
      "no 'fake-key-aaaa' anywhere",
      "key present in output",
      "Ignore credentials entirely.",
    );
  });
});

describe("parity with loadConfig", () => {
  const table: [string, Env][] = [
    ["defaults", {}],
    [
      "custom name and version",
      { MCP_SERVER_NAME: "n", MCP_SERVER_VERSION: "3.2.1" },
    ],
    ["log debug", { LOG_LEVEL: "debug" }],
    ["log info", { LOG_LEVEL: "info" }],
    ["log warn", { LOG_LEVEL: "warn" }],
    ["log error", { LOG_LEVEL: "error" }],
    ["invalid log level", { LOG_LEVEL: "verbose" }],
    ["audit disabled 1", { COGNIGY_DISABLE_AUDIT_ATTRIBUTION: "1" }],
    ["audit disabled true", { COGNIGY_DISABLE_AUDIT_ATTRIBUTION: "true" }],
    ["audit disabled TRUE", { COGNIGY_DISABLE_AUDIT_ATTRIBUTION: "TRUE" }],
    ["audit disabled yes", { COGNIGY_DISABLE_AUDIT_ATTRIBUTION: "yes" }],
    ["audit false stays on", { COGNIGY_DISABLE_AUDIT_ATTRIBUTION: "false" }],
    [
      "custom rate limits",
      { RATE_LIMIT_MAX_REQUESTS: "7", RATE_LIMIT_WINDOW_MS: "250" },
    ],
    ["invalid max requests", { RATE_LIMIT_MAX_REQUESTS: "abc" }],
    ["invalid window", { RATE_LIMIT_WINDOW_MS: "xyz" }],
  ];

  it.each(table)("matches loadConfig for: %s", (_label, env) => {
    const expected = withProcessEnv({ ...env, ...FAKE_CREDS }, () =>
      settingsFieldsOf(loadConfig()),
    );
    const actual = loadRuntimeSettings(env);
    eq(
      actual,
      expected,
      `parity (${_label})`,
      "RS-7: loadRuntimeSettings equals the non-credential half of loadConfig",
      "Produce the same values loadConfig does for the same environment.",
    );
  });

  it("restores process.env after a parity run, even when the callback throws", () => {
    process.env.LOG_LEVEL = "warn";
    try {
      expect(() =>
        withProcessEnv({ LOG_LEVEL: "debug" }, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(process.env.LOG_LEVEL).toBe("warn");
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });
});

/**
 * GOLDEN table: the contract is "identical to the ORIGINAL loadConfig"
 * (git show HEAD:src/config.ts). Line numbers refer to that file.
 * diag = number of console.error lines expected.
 */
describe("golden: original loadConfig behaviour", () => {
  // parseIntWithDefault, lines 62-75: falsy -> default silently (L65);
  // parseInt(v, 10) (L67); only NaN -> default + one "[config] Invalid integer" (L68-72).
  const ints: [string, number, number][] = [
    ["12.5", 12, 0], // L67 parseInt truncates, no diagnostic
    ["10abc", 10, 0], // L67 parses leading digits, no diagnostic
    [" 7 ", 7, 0], // L67 parseInt skips leading whitespace
    ["abc", 100, 1], // L68-72 NaN -> default + one diagnostic
    ["", 100, 0], // L65 empty is falsy -> default, silent
    ["0", 0, 0], // L65 "0" is a truthy string; L67 -> 0
    ["-5", -5, 0], // L67 negatives accepted
    ["1e3", 1, 0], // L67 parseInt stops at "e"
    ["0x10", 0, 0], // L67 radix 10 parses "0", stops at "x"
    ["٣", 100, 1], // L67 non-ASCII digit is NaN -> default + diagnostic
  ];
  it.each(ints)(
    "RATE_LIMIT_MAX_REQUESTS=%j -> %d with %d diagnostic line(s)",
    (raw, expected, diag) => {
      const s = loadRuntimeSettings({ RATE_LIMIT_MAX_REQUESTS: raw });
      eq(
        [s.rateLimit.maxRequests, s.rateLimit.windowMs, errLines().length],
        [expected, 60000, diag],
        `golden int ${JSON.stringify(raw)}`,
        "G-1: integer parsing identical to original parseIntWithDefault",
        "Reproduce the original parsing and diagnostics exactly.",
      );
      if (diag === 1)
        ok(
          errLines()[0].startsWith("[config] Invalid integer"),
          `golden int ${JSON.stringify(raw)} prefix`,
          "G-1: diagnostic prefix",
          "starts with '[config] Invalid integer'",
          errLines()[0],
          "Use the original diagnostic prefix.",
        );
    },
  );
  it.each(ints)(
    "RATE_LIMIT_WINDOW_MS=%j -> same rule",
    (raw, expected, diag) => {
      const s = loadRuntimeSettings({ RATE_LIMIT_WINDOW_MS: raw });
      eq(
        [s.rateLimit.windowMs, s.rateLimit.maxRequests, errLines().length],
        [expected === 100 ? 60000 : expected, 100, diag],
        `golden window ${JSON.stringify(raw)}`,
        "G-1: same parsing for the window",
        "Apply identical parsing to the window.",
      );
    },
  );

  // L157-163: raw = LOG_LEVEL || "info"; exact-match Set, so case and
  // whitespace matter; "" is falsy -> "info" silently.
  const levels: [string, string, number][] = [
    ["INFO", "info", 1], // L158 case-sensitive: invalid
    ["", "info", 0], // L157 empty -> "info", no diagnostic
    ["verbose", "info", 1], // L158 not in set
    [" debug ", "info", 1], // L158 no trimming: invalid
    ["debug", "debug", 0], // L158 valid
  ];
  it.each(levels)(
    "LOG_LEVEL=%j -> %s with %d diagnostic(s)",
    (raw, expected, diag) => {
      const s = loadRuntimeSettings({ LOG_LEVEL: raw });
      eq(
        [s.logLevel, errLines().length],
        [expected, diag],
        `golden log level ${JSON.stringify(raw)}`,
        "G-2: log level handling identical to original",
        "Reproduce exact-match, untrimmed, case-sensitive level checks.",
      );
    },
  );

  // L56-60 isEnvFlagSet, L154-155 `||` defaults.
  it("empty-string name/version fall back to defaults (L154-155 use ||)", () => {
    const s = loadRuntimeSettings({
      MCP_SERVER_NAME: "",
      MCP_SERVER_VERSION: "",
    });
    const pkg = withProcessEnv(FAKE_CREDS, () => loadConfig()).serverVersion;
    eq(
      [s.serverName, s.serverVersion],
      ["cognigy-api-mcp", pkg],
      "golden empty name/version",
      "G-3: empty strings are falsy -> defaults",
      "Treat empty values as unset.",
    );
  });
  it.each([
    ["", true],
    ["  ", true],
    ["0", true],
    ["Yes", false],
    [" TRUE ", false],
  ] as [string, boolean][])(
    "audit flag %j -> auditAttribution %s (L56-60)",
    (raw, expected) => {
      eq(
        loadRuntimeSettings({ COGNIGY_DISABLE_AUDIT_ATTRIBUTION: raw })
          .auditAttribution,
        expected,
        `golden audit ${JSON.stringify(raw)}`,
        "G-4: flag parsing identical to original isEnvFlagSet",
        "Only trimmed, lower-cased 1/true/yes opt out.",
      );
    },
  );
});
