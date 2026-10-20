import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

type CliResult = { status: number | null; error?: Error };

const detectOnPath = jest.fn<(...a: unknown[]) => boolean | string>();
const runCliTool = jest.fn<(...a: unknown[]) => CliResult>();
const writeUserConfigFile = jest.fn<(...a: unknown[]) => string>();

jest.unstable_mockModule("../install/cliRunner.js", () => ({
  detectOnPath,
  runCliTool,
}));
jest.unstable_mockModule("../userConfigFile.js", () => ({
  writeUserConfigFile,
}));

const {
  buildMarketplaceAddArgs,
  buildMarketplaceRemoveArgs,
  buildPluginInstallArgs,
  buildPluginUninstallArgs,
  buildPluginUpdateArgs,
  fallbackCommands,
  updateFallbackCommands,
  uninstallFallbackCommands,
  autoUpdateHint,
  installClaudeCode,
} = await import("../install/claudeCode.js");

const KEY = "test-key-123";
const URL = "https://api-trial.cognigy.ai";
const CREDS = { COGNIGY_API_BASE_URL: URL, COGNIGY_API_KEY: KEY };
const MOCK_CONFIG_PATH = "/mock/home/.cognigy-plugin/config.json";
const CLAUDE_PATH = "C:\\tools\\claude.cmd";

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
  mode: "equal" | "contains" = "equal",
): void {
  try {
    if (mode === "contains") {
      expect(String(actual)).toContain(String(expected));
    } else {
      expect(actual).toEqual(expected);
    }
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED${mode === "contains" ? " (substring)" : ""}: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

const ID = "cognigy@cognigy-plugin-v2";
const REPO = "emilyanderson-nice/cognigy-plugin";
const PROJECT_INSTALL_ARGV = [
  "plugin",
  "install",
  ID,
  "--scope",
  "project",
  "--config",
  `cognigy_api_base_url=${URL}`,
  "--config",
  `cognigy_api_key=${KEY}`,
];

describe("argv builders: fork identity and scope", () => {
  it("marketplace add, user scope (default)", () => {
    check(
      "buildMarketplaceAddArgs()",
      "Default scope is user and uses the fork repo",
      ["plugin", "marketplace", "add", REPO],
      buildMarketplaceAddArgs(),
      "Use the fork repo slug; add no scope flag for user scope.",
    );
  });

  it("marketplace add, project scope", () => {
    check(
      "buildMarketplaceAddArgs('project')",
      "Project scope appends --scope project",
      ["plugin", "marketplace", "add", REPO, "--scope", "project"],
      buildMarketplaceAddArgs("project"),
      "Accept a scope parameter and append the scope flag and value for project.",
    );
  });

  it("plugin install, user scope carries creds via --config", () => {
    check(
      "buildPluginInstallArgs(CREDS)",
      "User install keeps today's shape with the new plugin id",
      [
        "plugin",
        "install",
        ID,
        "--scope",
        "user",
        "--config",
        `cognigy_api_base_url=${URL}`,
        "--config",
        `cognigy_api_key=${KEY}`,
      ],
      buildPluginInstallArgs(CREDS),
      "Switch to the fork plugin id; leave the rest of the user-scope argv unchanged.",
    );
  });

  it("plugin install, explicit user scope equals default", () => {
    check(
      "buildPluginInstallArgs(CREDS, 'user')",
      "Explicit user scope is identical to the default",
      buildPluginInstallArgs(CREDS),
      buildPluginInstallArgs(CREDS, "user"),
      "Default the scope parameter to 'user'.",
    );
  });

  it("plugin install, project scope carries --config so required plugin config is set", () => {
    check(
      "buildPluginInstallArgs(CREDS, 'project')",
      "The plugin declares two required userConfig options; without --config Claude Code refuses to start the MCP server",
      PROJECT_INSTALL_ARGV,
      buildPluginInstallArgs(CREDS, "project"),
      "Pass --config cognigy_api_base_url=<URL> then --config cognigy_api_key=<KEY> at project scope, exactly as user scope does.",
    );
  });

  it("plugin install, project argv equals user argv except for the scope value", () => {
    const user = buildPluginInstallArgs(CREDS, "user");
    const project = buildPluginInstallArgs(CREDS, "project");
    const scopeIdx = user.indexOf("--scope") + 1;
    check(
      "project argv vs user argv",
      "Project and user install differ only in the scope value",
      user.map((x, i) => (i === scopeIdx ? "project" : x)),
      project,
      "Build both scopes from one code path; only the value after --scope may differ.",
    );
    check(
      "user argv scope position",
      "Guard against a vacuous comparison: --scope exists in the user argv",
      true,
      scopeIdx > 0 && user[scopeIdx] === "user",
      "Keep '--scope <scope>' in the install argv.",
    );
  });

  it("update / uninstall / marketplace remove use the new identity", () => {
    check(
      "buildPluginUpdateArgs()",
      "Update targets the fork plugin id",
      ["plugin", "update", ID],
      buildPluginUpdateArgs(),
      "Use the fork plugin id.",
    );
    check(
      "buildPluginUninstallArgs()",
      "Uninstall targets the fork plugin id",
      ["plugin", "uninstall", ID],
      buildPluginUninstallArgs(),
      "Use the fork plugin id.",
    );
    check(
      "buildMarketplaceRemoveArgs()",
      "Marketplace remove targets the fork marketplace name",
      ["plugin", "marketplace", "remove", "cognigy-plugin-v2"],
      buildMarketplaceRemoveArgs(),
      "Use the fork marketplace name.",
    );
  });

  it("fallback and hint text use the new identity", () => {
    check(
      "fallbackCommands()",
      "Manual fallback commands name the fork",
      [`/plugin marketplace add ${REPO}`, `/plugin install ${ID}`],
      fallbackCommands(),
      "Use the fork repo and plugin id.",
    );
    const joinedUpdate = updateFallbackCommands().join("\n");
    const joinedUninstall = uninstallFallbackCommands().join("\n");
    check(
      "updateFallbackCommands()",
      "Update fallback names the fork plugin id",
      ID,
      joinedUpdate,
      "Use the fork plugin id.",
      "contains",
    );
    check(
      "updateFallbackCommands() old identity",
      "Update fallback must not mention the upstream plugin id",
      false,
      /cognigy@cognigy-plugin(?!-v2)/.test(joinedUpdate),
      "Remove the upstream id.",
    );
    check(
      "uninstallFallbackCommands()",
      "Uninstall fallback names the fork plugin id",
      ID,
      joinedUninstall,
      "Use the fork plugin id.",
      "contains",
    );
    check(
      "uninstallFallbackCommands() old identity",
      "Uninstall fallback must not mention the upstream plugin id",
      false,
      /cognigy@cognigy-plugin(?!-v2)/.test(joinedUninstall),
      "Remove the upstream id.",
    );
    const hint =
      typeof autoUpdateHint === "function" ? autoUpdateHint() : autoUpdateHint;
    check(
      "autoUpdateHint",
      "Auto-update hint names the fork marketplace",
      "cognigy-plugin-v2",
      hint,
      "Use the fork marketplace name.",
      "contains",
    );
    check(
      "autoUpdateHint old identity",
      "Auto-update hint must not mention upstream marketplace",
      false,
      /Cognigy\/cognigy-plugin|cognigy-plugin(?!-v2)/.test(String(hint)),
      "Remove the upstream name.",
    );
  });
});

describe("installClaudeCode", () => {
  const calls: string[] = [];
  const argvs: string[][] = [];
  const cliCalls: unknown[][] = [];
  let errSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  /** Statuses per CLI call index: [marketplaceAdd, pluginInstall]. */
  function setup(opts: {
    onPath: boolean;
    statuses?: number[];
    /** Error attached to the first CLI call's result (e.g. spawn ENOENT). */
    firstCallError?: Error;
  }): void {
    calls.length = 0;
    argvs.length = 0;
    cliCalls.length = 0;
    detectOnPath.mockReset().mockReturnValue(opts.onPath ? CLAUDE_PATH : false);
    writeUserConfigFile.mockReset().mockImplementation((...a) => {
      calls.push("write");
      writeArgs.push(a);
      return MOCK_CONFIG_PATH;
    });
    runCliTool.mockReset().mockImplementation((...a) => {
      calls.push("cli");
      cliCalls.push([...a]);
      // The args array is the first array argument, whatever the signature.
      const argv = (a.find((x) => Array.isArray(x)) as string[]) ?? [];
      argvs.push(argv);
      const status = (opts.statuses ?? [])[argvs.length - 1] ?? 0;
      if (argvs.length === 1 && opts.firstCallError) {
        return { status: 0, error: opts.firstCallError };
      }
      return { status, error: undefined };
    });
  }
  const writeArgs: unknown[][] = [];

  /** Everything written to stderr / console.error / console.log so far, stringified. */
  function capturedOutput(): string {
    const all = [
      ...errSpy.mock.calls,
      ...logSpy.mock.calls,
      ...stderrSpy.mock.calls,
    ];
    return all
      .map((args) =>
        (args as unknown[])
          .map((x) =>
            typeof x === "string"
              ? x
              : String(x instanceof Error ? x.message : JSON.stringify(x)),
          )
          .join(" "),
      )
      .join("\n");
  }

  function attempt(fn: () => unknown): Error | undefined {
    try {
      fn();
    } catch (e) {
      return e as Error;
    }
    return undefined;
  }

  /** Every runCliTool call must be ("claude", <detected path>, argv array). */
  function checkRunnerShape(label: string, expectedCount: number): void {
    check(
      `${label}: runner call count`,
      "Guard against a vacuous check: the expected number of CLI calls happened",
      expectedCount,
      cliCalls.length,
      "Call runCliTool once per CLI step.",
    );
    check(
      `${label}: runner command and resolved path`,
      "Each call passes 'claude' then the exact path detectOnPath returned",
      cliCalls.map(() => ["claude", CLAUDE_PATH]),
      cliCalls.map((c) => [c[0], c[1]]),
      "Call runCliTool('claude', <path returned by detectOnPath>, argv).",
    );
    check(
      `${label}: runner argv is third positional`,
      "The argv array is the third argument of every call",
      argvs,
      cliCalls.map((c) => c[2]),
      "Pass the argv array as the third argument to runCliTool.",
    );
  }

  let logSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    writeArgs.length = 0;
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const MP_ADD_PROJECT = [
    "plugin",
    "marketplace",
    "add",
    REPO,
    "--scope",
    "project",
  ];
  const INSTALL_PROJECT = PROJECT_INSTALL_ARGV;

  it("project scope, all ok: add then install, creds never written, method cli", () => {
    setup({ onPath: true });
    const result = installClaudeCode(CREDS, "project");
    check(
      "project happy path: CLI argv sequence",
      "Marketplace add then plugin install, in that order, nothing else",
      [MP_ADD_PROJECT, INSTALL_PROJECT],
      argvs,
      "Run exactly the project-scope marketplace add followed by project-scope install.",
    );
    check(
      "project happy path: creds file writes",
      "Project scope must never write the user creds file",
      0,
      writeUserConfigFile.mock.calls.length,
      "Do not call writeUserConfigFile in project scope.",
    );
    checkRunnerShape("project happy path", 2);
    check(
      "project happy path: return value",
      "Returns { method: 'cli' } when CLI succeeds",
      { method: "cli" },
      result,
      "Return exactly { method: 'cli' } on success.",
    );
  });

  it("project scope: marketplace add failure aborts before install and before writing creds", () => {
    setup({ onPath: true, statuses: [1] });
    let thrown: Error | undefined;
    try {
      installClaudeCode(CREDS, "project");
    } catch (e) {
      thrown = e as Error;
    }
    check(
      "project marketplace add failure: throws",
      "A failed marketplace add in project scope is fatal",
      true,
      thrown instanceof Error,
      "Throw an Error when the project-scope marketplace add exits non-zero.",
    );
    check(
      "project marketplace add failure: message",
      "Message mentions the marketplace add failure",
      "marketplace add",
      thrown?.message.toLowerCase(),
      "Name the failing step in the error message.",
      "contains",
    );
    check(
      "project marketplace add failure: exit status",
      "Message mentions the exit status",
      true,
      /\b1\b/.test(thrown?.message ?? ""),
      "Include the numeric exit status in the error message.",
    );
    check(
      "project marketplace add failure: CLI calls",
      "Plugin install is never run after a failed add",
      [MP_ADD_PROJECT],
      argvs,
      "Stop immediately after the failed marketplace add.",
    );
    check(
      "project marketplace add failure: creds writes",
      "Creds file is not written when nothing was installed",
      0,
      writeUserConfigFile.mock.calls.length,
      "Do not write the creds file before the marketplace add succeeds.",
    );
  });

  it("project scope: install failure throws and the creds file is never written", () => {
    setup({ onPath: true, statuses: [0, 1] });
    let thrown: Error | undefined;
    try {
      installClaudeCode(CREDS, "project");
    } catch (e) {
      thrown = e as Error;
    }
    check(
      "project install failure: throws",
      "A failed plugin install is fatal",
      true,
      thrown instanceof Error,
      "Throw an Error when plugin install exits non-zero.",
    );
    check(
      "project install failure: CLI calls",
      "Both add and install were attempted",
      [MP_ADD_PROJECT, INSTALL_PROJECT],
      argvs,
      "Run add, then install, before failing.",
    );
    check(
      "project install failure: creds writes",
      "Project scope never writes the creds file, even when install fails",
      0,
      writeUserConfigFile.mock.calls.length,
      "Do not call writeUserConfigFile in project scope.",
    );
    checkRunnerShape("project install failure", 2);
  });

  it("project scope, claude not on PATH: throws pointing at /plugin, no CLI call, no creds write", () => {
    setup({ onPath: false });
    const thrown = attempt(() => installClaudeCode(CREDS, "project"));
    check(
      "project no claude: throws",
      "Project scope cannot fall back to a creds file, so it must fail loudly",
      true,
      thrown instanceof Error,
      "Throw an Error when claude is not on PATH in project scope.",
    );
    const msg = thrown?.message ?? "";
    for (const word of ["claude", "PATH", "/plugin"]) {
      check(
        `project no claude: message mentions ${word}`,
        "Message says which program is missing, where it was looked for, and the in-app alternative",
        word,
        msg,
        `Mention '${word}' in the error message.`,
        "contains",
      );
    }
    check(
      "project no claude: CLI calls",
      "No CLI is run when claude is not on PATH",
      0,
      runCliTool.mock.calls.length,
      "Check PATH first and skip all CLI calls.",
    );
    check(
      "project no claude: creds writes",
      "Project scope never writes the creds file",
      0,
      writeUserConfigFile.mock.calls.length,
      "Do not call writeUserConfigFile in project scope.",
    );
  });

  it("user scope, claude not on PATH: still falls back and writes creds once", () => {
    setup({ onPath: false });
    const result = installClaudeCode(CREDS);
    check(
      "user fallback: CLI calls",
      "No CLI is run when claude is not on PATH",
      0,
      runCliTool.mock.calls.length,
      "Check PATH first and skip all CLI calls.",
    );
    check(
      "user fallback: creds writes",
      "User scope writes the creds file exactly once in the fallback path",
      [[CREDS]],
      writeArgs.map((a) => [a[0]]),
      "Write the creds file once in the fallback path.",
    );
    check(
      "user fallback: return value",
      "Returns fallback result with config path and manual commands",
      {
        method: "fallback",
        configFile: MOCK_CONFIG_PATH,
        commands: fallbackCommands(),
      },
      result,
      "Return { method: 'fallback', configFile, commands: fallbackCommands() }.",
    );
  });

  it("project scope: recorded argv list is exactly [marketplace add, install with --config] in both paths", () => {
    // Happy path
    setup({ onPath: true });
    installClaudeCode(CREDS, "project");
    const happy = argvs.map((a) => [...a]);
    const happyCount = argvs.length;
    // Install-failure path
    setup({ onPath: true, statuses: [0, 1] });
    attempt(() => installClaudeCode(CREDS, "project"));
    const failed = argvs.map((a) => [...a]);
    const failedCount = argvs.length;
    check(
      "recorded argv (happy path)",
      "Exactly marketplace add then project install carrying both --config pairs",
      [MP_ADD_PROJECT, PROJECT_INSTALL_ARGV],
      happy,
      "Run only the project marketplace add and the project install with --config for URL and key.",
    );
    check(
      "recorded argv (failure path)",
      "Exactly marketplace add then project install carrying both --config pairs",
      [MP_ADD_PROJECT, PROJECT_INSTALL_ARGV],
      failed,
      "Run only the project marketplace add and the project install with --config for URL and key.",
    );
    check(
      "recorded argv (argv recorded at all)",
      "Guard against a vacuous check: two argv per scenario were captured",
      [2, 2],
      [happyCount, failedCount],
      "Ensure the CLI runner receives the argv as an array argument.",
    );
  });

  it("user scope regression: failed marketplace add logs and install still runs with user argv", () => {
    setup({ onPath: true, statuses: [1, 0] });
    const result = installClaudeCode(CREDS);
    check(
      "user scope: CLI argv sequence",
      "User scope continues to install after a failed marketplace add",
      [buildMarketplaceAddArgs(), buildPluginInstallArgs(CREDS)],
      argvs,
      "Keep user-scope tolerance: log the add failure and still run install.",
    );
    checkRunnerShape("user scope", 2);
    const logged = errSpy.mock.calls.length + stderrSpy.mock.calls.length;
    check(
      "user scope: failure logged to stderr",
      "The add failure is logged to stderr",
      true,
      logged > 0,
      "Write a message to stderr (console.error or process.stderr) on add failure.",
    );
    check(
      "user scope: return value",
      "Install success yields { method: 'cli' }",
      { method: "cli" },
      result,
      "Return { method: 'cli' } when plugin install succeeds.",
    );
  });

  it("project scope: marketplace add spawn error (claude ENOENT) is fatal and stops everything", () => {
    setup({
      onPath: true,
      firstCallError: new Error("spawn claude ENOENT"),
    });
    const thrown = attempt(() => installClaudeCode(CREDS, "project"));
    check(
      "project marketplace add spawn error: throws",
      "A marketplace add that could not even spawn is fatal in project scope",
      true,
      thrown instanceof Error,
      "Treat a runner result carrying an error as a failed step and throw.",
    );
    check(
      "project marketplace add spawn error: message",
      "Message names the failing step",
      "marketplace add",
      thrown?.message.toLowerCase(),
      "Name the failing step in the error message.",
      "contains",
    );
    check(
      "project marketplace add spawn error: CLI calls",
      "Plugin install is never run after the add failed to spawn",
      [MP_ADD_PROJECT],
      argvs,
      "Stop immediately after the failed marketplace add.",
    );
    check(
      "project marketplace add spawn error: creds writes",
      "Creds file is not written when nothing was installed",
      0,
      writeUserConfigFile.mock.calls.length,
      "Do not write the creds file before the marketplace add succeeds.",
    );
  });

  it("project scope: thrown messages never contain the key or the URL", () => {
    setup({ onPath: true, statuses: [0, 1] });
    const installFail = attempt(() => installClaudeCode(CREDS, "project"));
    setup({ onPath: true, statuses: [1] });
    const addFail = attempt(() => installClaudeCode(CREDS, "project"));
    check(
      "secrets in messages (guard: install failure threw)",
      "Guard against a vacuous check: the install failure produced a message",
      true,
      typeof installFail?.message === "string" &&
        installFail.message.length > 0,
      "Throw an Error with a non-empty message when plugin install fails.",
    );
    check(
      "secrets in messages (guard: add failure threw)",
      "Guard against a vacuous check: the add failure produced a message",
      true,
      typeof addFail?.message === "string" && addFail.message.length > 0,
      "Throw an Error with a non-empty message when marketplace add fails.",
    );
    for (const [label, err] of [
      ["install failure", installFail],
      ["marketplace add failure", addFail],
    ] as const) {
      check(
        `secrets in messages (${label}): key`,
        "The API key must never appear in an error message",
        false,
        (err?.message ?? "").includes(KEY),
        "Do not interpolate credentials into error text.",
      );
      check(
        `secrets in messages (${label}): url`,
        "The API base URL must never appear in an error message",
        false,
        (err?.message ?? "").includes(URL),
        "Do not interpolate credentials into error text.",
      );
    }
  });

  it("project scope: the key never reaches stderr, console.error or console.log in any scenario", () => {
    setup({ onPath: true });
    installClaudeCode(CREDS, "project");
    const afterHappy = capturedOutput();
    setup({ onPath: true, statuses: [0, 1] });
    const installFail = attempt(() => installClaudeCode(CREDS, "project"));
    setup({ onPath: true, statuses: [1] });
    const addFail = attempt(() => installClaudeCode(CREDS, "project"));
    const all = capturedOutput();
    check(
      "key in output (guard: scenarios ran)",
      "Guard against a vacuous check: both failure scenarios threw",
      [true, true],
      [installFail instanceof Error, addFail instanceof Error],
      "Throw on install failure and on marketplace add failure in project scope.",
    );
    check(
      "key in output (guard: spies capture strings)",
      "Guard against a vacuous check: the capture helper stringifies calls",
      true,
      typeof all === "string" && typeof afterHappy === "string",
      "Not an implementation concern; the capture helper must return text.",
    );
    check(
      "key in output (happy path)",
      "The API key must never be printed on the happy path",
      false,
      afterHappy.includes(KEY),
      "Never write credentials to any output stream.",
    );
    check(
      "key in output (all scenarios)",
      "The API key must never be printed in any scenario",
      false,
      all.includes(KEY),
      "Never write credentials to any output stream.",
    );
  });

  it("project scope happy path: order is marketplace add then plugin install, no creds write", () => {
    setup({ onPath: true });
    installClaudeCode(CREDS, "project");
    check(
      "project happy path: call order",
      "Only the two CLI steps run, with no creds write between or after",
      ["cli", "cli"],
      [...calls],
      "Run marketplace add, then plugin install; never write the creds file.",
    );
  });

  it("project scope install failure: order is add then failed install, no creds write", () => {
    setup({ onPath: true, statuses: [0, 1] });
    attempt(() => installClaudeCode(CREDS, "project"));
    check(
      "project install failure: call order",
      "Only the two CLI steps run before the throw, with no creds write",
      ["cli", "cli"],
      [...calls],
      "Run marketplace add, run plugin install, then throw; never write the creds file.",
    );
  });

  it("project scope install failure: message points at cognigy-setup install --project and /plugin configure", () => {
    setup({ onPath: true, statuses: [0, 1] });
    const thrown = attempt(() => installClaudeCode(CREDS, "project"));
    const msg = thrown?.message ?? "";
    check(
      "project install failure message: guard",
      "Guard against a vacuous check: a message was produced",
      true,
      msg.length > 0,
      "Throw an Error with a non-empty message when plugin install fails.",
    );
    check(
      "project install failure message: setup command",
      "Message tells the user to re-run the installer in project mode",
      "cognigy-setup install --project",
      msg,
      "Include 'cognigy-setup install --project' in the error message.",
      "contains",
    );
    for (const forbidden of [
      "Wrote creds",
      "config.json",
      MOCK_CONFIG_PATH,
      "claude plugin install cognigy@cognigy-plugin-v2 --scope project",
    ]) {
      check(
        `project install failure message: no ${forbidden}`,
        "A bare retry or a creds-file reference would yield an unconfigured plugin",
        false,
        msg.includes(forbidden),
        `Remove '${forbidden}' from the project install failure message.`,
      );
    }
    check(
      "project install failure message: configure hint",
      "Message tells the user how to set the URL and key without a command line",
      "/plugin configure cognigy@cognigy-plugin-v2",
      msg,
      "Include '/plugin configure cognigy@cognigy-plugin-v2' in the project error message.",
      "contains",
    );
    check(
      "project install failure message: no key",
      "The API key must never appear in the message",
      false,
      msg.includes(KEY),
      "Do not interpolate credentials into error text.",
    );
    check(
      "project install failure message: no url",
      "The API base URL must never appear in the message",
      false,
      msg.includes(URL),
      "Do not interpolate credentials into error text.",
    );
    check(
      "project install failure message: no /plugin install",
      "Project message must not suggest user-scope slash commands",
      false,
      msg.includes("/plugin install"),
      "Do not reuse the user-scope fallback commands in project scope.",
    );
    check(
      "project install failure message: no /plugin marketplace add",
      "Project message must not suggest user-scope slash commands",
      false,
      msg.includes("/plugin marketplace add"),
      "Do not reuse the user-scope fallback commands in project scope.",
    );
  });

  it("user scope regression: install failure message lists the fallback commands and config path", () => {
    setup({ onPath: true, statuses: [0, 1] });
    const thrown = attempt(() => installClaudeCode(CREDS));
    check(
      "user install failure: throws",
      "A failed plugin install is fatal in user scope too",
      true,
      thrown instanceof Error,
      "Throw an Error when plugin install exits non-zero.",
    );
    const msg = thrown?.message ?? "";
    for (const cmd of fallbackCommands()) {
      check(
        `user install failure message: ${cmd}`,
        "Message lists every manual fallback command",
        cmd,
        msg,
        "Include each fallbackCommands() entry in the error message.",
        "contains",
      );
    }
    check(
      "user install failure message: config path",
      "Message names where the creds were saved",
      MOCK_CONFIG_PATH,
      msg,
      "Include the written config file path in the error message.",
      "contains",
    );
  });

  describe("credential safety", () => {
    const BAD_CHARS: [string, string][] = [
      ["double quote", '"'],
      ["percent sign", "%"],
      ["carriage return", "\r"],
      ["line feed", "\n"],
      ["NUL", "\0"],
    ];
    const FIELDS = [
      ["API key", "COGNIGY_API_KEY"],
      ["API base URL", "COGNIGY_API_BASE_URL"],
    ] as const;
    const SCOPES = ["user", "project"] as const;
    const cases = BAD_CHARS.flatMap(([charName, ch]) =>
      FIELDS.flatMap(([fieldName, envName]) =>
        SCOPES.map(
          (scope) => [charName, fieldName, scope, ch, envName] as const,
        ),
      ),
    );

    it.each(cases)(
      "%s in the %s is rejected in %s scope before any CLI call or creds write",
      (charName, fieldName, scope, ch, envName) => {
        const bad =
          envName === "COGNIGY_API_KEY"
            ? `test-key${ch}123`
            : `https://api-trial.cognigy.ai${ch}/x`;
        const creds = { ...CREDS, [envName]: bad };
        setup({ onPath: true });
        const thrown = attempt(() => installClaudeCode(creds, scope));
        const label = `${charName} in ${fieldName} (${scope})`;
        check(
          `${label}: throws`,
          "Values that cannot be passed safely on the command line are rejected",
          true,
          thrown instanceof Error,
          "Throw an Error when the key or URL contains a double quote, percent, CR, LF or NUL.",
        );
        const msg = thrown?.message ?? "";
        check(
          `${label}: message wording`,
          "Message says the value cannot be passed safely",
          "cannot be passed safely",
          msg,
          "Include 'cannot be passed safely' in the error message.",
          "contains",
        );
        check(
          `${label}: message names the field`,
          "Message names which field is bad",
          fieldName,
          msg,
          `Include '${fieldName}' in the error message.`,
          "contains",
        );
        check(
          `${label}: message does not echo the value`,
          "The offending value must never appear in the message",
          false,
          msg.includes(bad) ||
            msg.includes("test-key") ||
            msg.includes("api-trial"),
          "Do not interpolate any part of the credential into the error text.",
        );
        check(
          `${label}: CLI calls`,
          "Validation happens before any CLI call",
          0,
          runCliTool.mock.calls.length,
          "Validate both values before calling runCliTool.",
        );
        check(
          `${label}: creds writes`,
          "Validation happens before any creds write",
          0,
          writeUserConfigFile.mock.calls.length,
          "Validate both values before calling writeUserConfigFile.",
        );
      },
    );

    it.each(SCOPES)(
      "unsafe value is rejected in %s scope even when claude is not on PATH (no fallback write)",
      (scope) => {
        setup({ onPath: false });
        const thrown = attempt(() =>
          installClaudeCode({ ...CREDS, COGNIGY_API_KEY: 'bad"key' }, scope),
        );
        check(
          `unsafe key, no claude (${scope}): message`,
          "Validation precedes the PATH check and the fallback write",
          "cannot be passed safely",
          thrown?.message,
          "Validate credentials first thing in installClaudeCode.",
          "contains",
        );
        check(
          `unsafe key, no claude (${scope}): creds writes`,
          "No creds file is written for a rejected value",
          0,
          writeUserConfigFile.mock.calls.length,
          "Do not write the creds file when validation fails.",
        );
      },
    );

    const SAFE_KEY = "a&b^c=d+e/f$g h";
    const SAFE_URL = "https://api-trial.cognigy.ai/path?a=1&b=2";
    it.each(SCOPES)(
      "safe special characters (& ^ = + / $ space, URL query string) still install in %s scope",
      (scope) => {
        const creds = {
          COGNIGY_API_BASE_URL: SAFE_URL,
          COGNIGY_API_KEY: SAFE_KEY,
        };
        setup({ onPath: true });
        const result = installClaudeCode(creds, scope);
        check(
          `safe values (${scope}): return value`,
          "Safe values install through the CLI",
          { method: "cli" },
          result,
          "Do not reject & ^ = + / $ space or a URL query string.",
        );
        check(
          `safe values (${scope}): install argv`,
          "Values reach the CLI verbatim as single argv elements",
          [
            "plugin",
            "install",
            ID,
            "--scope",
            scope,
            "--config",
            `cognigy_api_base_url=${SAFE_URL}`,
            "--config",
            `cognigy_api_key=${SAFE_KEY}`,
          ],
          argvs[1],
          "Pass the values unmodified in --config key=value arguments.",
        );
        checkRunnerShape(`safe values (${scope})`, 2);
        check(
          `safe values (${scope}): key never printed`,
          "The API key must never be printed",
          false,
          capturedOutput().includes(SAFE_KEY),
          "Never write credentials to any output stream.",
        );
      },
    );
  });
});
