import { describe, it, expect } from "@jest/globals";
import { spawnSync } from "child_process";
import { join } from "path";
import { pathToFileURL } from "url";

const BOOT_URL = pathToFileURL(
  join(process.cwd(), "scripts", "doctor-boot.mjs"),
).href;
const IDENTITY_URL = pathToFileURL(
  join(process.cwd(), "scripts", "fork-identity.mjs"),
).href;

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

/**
 * Evaluate an expression over `b` (scripts/doctor-boot.mjs namespace) and `id`
 * (scripts/fork-identity.mjs namespace) in a child node process. A missing
 * module or export yields { __missing: "..." } so the failure is an assertion.
 */
function evalBoot(expression: string): unknown {
  const code =
    `Promise.all([import(${JSON.stringify(BOOT_URL)}).catch(e=>({__err:String(e.message).split("\\n")[0]})),` +
    `import(${JSON.stringify(IDENTITY_URL)})]).then(([b,id])=>{` +
    `if(b.__err){console.log(JSON.stringify({__missing:b.__err}));return;}` +
    `try{console.log(JSON.stringify({value:(${expression})}))}catch(e){console.log(JSON.stringify({__missing:String(e.message)}))}})`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as { value?: unknown; __missing?: string };
    if (parsed.__missing !== undefined) return { missing: parsed.__missing };
    return { value: parsed.value };
  } catch {
    return {
      missing: `child exit ${r.status}: ${(r.stderr ?? "").split("\n")[0]}`,
    };
  }
}

const GUIDE_MISSING =
  "Create scripts/doctor-boot.mjs as a pure ES module (no top-level side effects) exporting bootSpawnPlan, killPlan and bootTimeoutMessage.";

function value(expression: string, name: string): unknown {
  const r = evalBoot(expression) as { value?: unknown; missing?: string };
  check(
    `${name}: scripts/doctor-boot.mjs is importable and exports the function`,
    "The platform-dependent boot logic lives in a pure, importable module",
    "evaluates without error",
    r.missing === undefined ? "evaluates without error" : r.missing,
    GUIDE_MISSING,
  );
  return r.value;
}

describe("bootSpawnPlan(version, platform)", () => {
  it("launches plain npx with exactly the shared engine launch args (includes --allow-git=root)", () => {
    const v = value(
      `{ command: b.bootSpawnPlan("1.22.0-pb.1","linux").command, args: b.bootSpawnPlan("1.22.0-pb.1","linux").args, expected: id.engineLaunchArgs("1.22.0-pb.1") }`,
      "bootSpawnPlan args",
    ) as { command: string; args: string[]; expected: string[] };
    check(
      "bootSpawnPlan command",
      "The command is always the bare name npx (the shell resolves npx.cmd on Windows)",
      "npx",
      v.command,
      "Return command: 'npx' regardless of platform.",
    );
    check(
      "bootSpawnPlan args equal engineLaunchArgs(version)",
      "Args must come from the shared engineLaunchArgs helper so the git flag is never dropped",
      v.expected,
      v.args,
      "Use engineLaunchArgs(version) from fork-identity.mjs as args.",
    );
    check(
      "bootSpawnPlan args literal for 1.22.0-pb.1",
      "npm needs --allow-git=root first, then -y -p <fork spec at the version tag> cognigy-mcp",
      [
        "--allow-git=root",
        "-y",
        "-p",
        "github:emilyanderson-nice/cognigy-plugin#v1.22.0-pb.1",
        "cognigy-mcp",
      ],
      v.args,
      "The args must be the five launch args in that exact order.",
    );
  });

  it("win32 uses a shell and is not detached", () => {
    const o = value(
      `b.bootSpawnPlan("1.22.0-pb.1","win32").options`,
      "bootSpawnPlan win32 options",
    ) as { shell: unknown; detached: unknown };
    check(
      "win32 spawn options",
      "Windows cannot spawn npx.cmd without a shell, and has no process groups to detach into",
      { shell: true, detached: false },
      { shell: o?.shell, detached: o?.detached },
      "For platform win32 set options.shell = true and options.detached = false.",
    );
  });

  it.each(["linux", "darwin"])(
    "%s uses no shell and is detached (own process group)",
    (platform) => {
      const o = value(
        `b.bootSpawnPlan("1.22.0-pb.1",${JSON.stringify(platform)}).options`,
        `bootSpawnPlan ${platform} options`,
      ) as { shell: unknown; detached: unknown };
      check(
        `${platform} spawn options`,
        "POSIX kills the whole tree via the process group, so the child must lead its own group",
        { shell: false, detached: true },
        { shell: o?.shell, detached: o?.detached },
        "For non-win32 platforms set options.shell = false and options.detached = true.",
      );
    },
  );

  it("returns fresh objects per call (mutation does not leak)", () => {
    const v = value(
      `(()=>{const a=b.bootSpawnPlan("1.22.0-pb.1","linux");a.args.push("X");a.options.shell=true;a.command="mutated";const c=b.bootSpawnPlan("1.22.0-pb.1","linux");return {args:c.args,shell:c.options.shell,command:c.command}})()`,
      "bootSpawnPlan freshness",
    ) as { args: string[]; shell: boolean; command: string };
    check(
      "bootSpawnPlan returns a fresh plan",
      "Mutating one returned plan must not alter the next call's result",
      {
        args: [
          "--allow-git=root",
          "-y",
          "-p",
          "github:emilyanderson-nice/cognigy-plugin#v1.22.0-pb.1",
          "cognigy-mcp",
        ],
        shell: false,
        command: "npx",
      },
      v,
      "Build a new command/args/options object on every call; do not share module-level arrays.",
    );
  });
});

describe("killPlan(platform, pid)", () => {
  it("win32 kills the whole tree with taskkill /T /F", () => {
    check(
      "killPlan win32 pid 4242",
      "process.kill(-pid) is POSIX-only; on Windows the tree must be killed via taskkill",
      { command: "taskkill", args: ["/pid", "4242", "/T", "/F"] },
      value(`b.killPlan("win32", 4242)`, "killPlan win32"),
      "Return { command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] } for win32.",
    );
  });

  it.each(["linux", "darwin"])(
    "%s sends SIGKILL to the negative pid (process group)",
    (platform) => {
      check(
        `killPlan ${platform} pid 4242`,
        "On POSIX the whole process group is killed by signalling the negated pid",
        { signal: "SIGKILL", pid: -4242 },
        value(
          `b.killPlan(${JSON.stringify(platform)}, 4242)`,
          `killPlan ${platform}`,
        ),
        "Return { signal: 'SIGKILL', pid: -pid } for non-win32 platforms.",
      );
    },
  );
});

describe("bootTimeoutMessage()", () => {
  const msg = (): string => {
    const v = value(`b.bootTimeoutMessage()`, "bootTimeoutMessage");
    return typeof v === "string" ? v : `<<not a string: ${typeof v}>>`;
  };

  it("exports BOOT_TIMEOUT_MS equal to exactly 240000", () => {
    check(
      "BOOT_TIMEOUT_MS",
      "The boot timeout is a single exported constant of 240 seconds",
      240000,
      value(`b.BOOT_TIMEOUT_MS`, "BOOT_TIMEOUT_MS"),
      "Export const BOOT_TIMEOUT_MS = 240000 from scripts/doctor-boot.mjs.",
    );
  });

  it("states the 240s limit, not 120s, and that a cold start can take 2 minutes", () => {
    const m = msg();
    check(
      "timeout message names the limit and the cold-start duration",
      "The limit is 240s; a cold install can still take about 2 minutes",
      { s240: true, s120: false, cold: true, twoMinutes: true },
      {
        s240: m.includes("240s"),
        s120: m.includes("120s"),
        cold: m.includes("cold"),
        twoMinutes: m.includes("2 minutes"),
      },
      "Mention the 240s timeout (not 120s), the word 'cold', and that a first start can take 2 minutes.",
    );
  });

  it("no longer claims the stale ~30s cold install", () => {
    check(
      "timeout message does not contain ~30s",
      "The old '~30s' figure is wrong and misleads users into thinking a slow install is a hang",
      false,
      msg().includes("~30s"),
      "Remove the ~30s claim from the message.",
    );
  });

  it("still points at installScripts.test.ts for hung install scripts", () => {
    check(
      "timeout message points at the hung-install-script test",
      "Users must still be directed to the test that catches hanging install scripts",
      true,
      msg().includes("installScripts.test.ts"),
      "Keep the reference to installScripts.test.ts in the message.",
    );
  });
});

describe("bootExitMessage(code, signal, stderrTail)", () => {
  const call = (code: unknown, signal: unknown, tail: string): string => {
    const v = value(
      `b.bootExitMessage(${JSON.stringify(code)},${JSON.stringify(signal)},${JSON.stringify(tail)})`,
      "bootExitMessage",
    );
    return typeof v === "string" ? v : `<<not a string: ${typeof v}>>`;
  };
  const HINT_SECTION = "Troubleshooting the first start";

  it("code 1 with an empty tail is exactly one plain sentence", () => {
    check(
      "bootExitMessage(1, null, '')",
      "An early exit is reported plainly, with no hint, tail or signal text",
      "The engine exited with code 1 before it answered.",
      call(1, null, ""),
      "Return exactly 'The engine exited with code <code> before it answered.' when there is no signal and the tail is empty.",
    );
  });

  it("includes a multi-line stderr tail verbatim", () => {
    const tail = "npm error code E404\nnpm error 404 Not Found";
    const m = call(1, null, tail);
    check(
      "tail verbatim",
      "The user must see the engine's own error output unaltered",
      { exited: true, code: true, tail: true },
      {
        exited: m.includes("exited"),
        code: m.includes("exited with code 1"),
        tail: m.includes(tail),
      },
      "Append the stderr tail text exactly as given when it is non-empty.",
    );
  });

  it("a tail without EALLOWGIT carries no EALLOWGIT hint and no README section name", () => {
    const m = call(1, null, "npm error code E404");
    check(
      "no hint for other errors",
      "The git-allow hint is shown only for EALLOWGIT failures",
      { hint: false, section: false },
      { hint: m.includes("EALLOWGIT"), section: m.includes(HINT_SECTION) },
      "Only mention EALLOWGIT and the README section when the tail contains EALLOWGIT.",
    );
  });

  it("a tail with EALLOWGIT points at the README section 'Troubleshooting the first start'", () => {
    const tail = "npm error code EALLOWGIT";
    const m = call(1, null, tail);
    check(
      "EALLOWGIT hint",
      "An EALLOWGIT failure must send the user to the README troubleshooting section",
      { code: true, tail: true, section: true },
      {
        code: m.includes("exited with code 1"),
        tail: m.includes(tail),
        section: m.includes(HINT_SECTION),
      },
      "When the tail contains EALLOWGIT, add a hint naming the README section 'Troubleshooting the first start'.",
    );
  });

  it("a signal exit names the signal", () => {
    const m = call(null, "SIGKILL", "");
    check(
      "signal exit",
      "A process killed by a signal must say which signal",
      { exited: true, signal: true, hint: false },
      {
        exited: m.includes("exited"),
        signal: m.includes("SIGKILL"),
        hint: m.includes(HINT_SECTION),
      },
      "Mention the signal name when signal is non-null.",
    );
  });

  it.each([
    [1, null, ""],
    [1, null, "npm error code EALLOWGIT"],
    [null, "SIGKILL", ""],
  ])(
    "never blames hung install scripts (code %s, signal %s, tail %j)",
    (code, signal, tail) => {
      const m = call(code, signal, tail);
      check(
        "no hung-install-script advice",
        "An early exit is not a hang; the timeout advice must not appear",
        { testRef: false, hung: false },
        {
          testRef: m.includes("installScripts.test.ts"),
          hung: /hung/i.test(m),
        },
        "Do not mention installScripts.test.ts or hung install scripts in the exit message.",
      );
    },
  );
});

describe("bootSpawnPlan(version, platform): version validation", () => {
  const probe = (version: string, platform: string) =>
    value(
      `(()=>{const v=${JSON.stringify(version)};try{b.bootSpawnPlan(v,${JSON.stringify(platform)});return {threw:false}}catch(e){return {threw:true,isError:e instanceof Error,hasVersion:String(e.message).includes(v),hasWord:String(e.message).includes("version")}}})()`,
      `bootSpawnPlan(${JSON.stringify(version)})`,
    );

  const BAD = [
    "1.22.0",
    "1.22.0-pb.2; calc",
    "1.22.0-pb.2 && echo x",
    "",
    "1.22.0-pb.",
    "v1.22.0-pb.2",
    "1.22.0-pb.2\n",
    "1.22.2-esc.1; calc",
    "1.22.2-esc.1 && echo x",
    "1.22.2-ESC.1",
    "1.22.2-esc.",
    "v1.22.2-esc.1",
    "1.22.2-esc.1\n",
  ];

  for (const platform of ["win32", "linux"]) {
    it.each(BAD)(`rejects %j on ${platform}`, (version) => {
      check(
        `bootSpawnPlan(${JSON.stringify(version)}, ${platform})`,
        "Only <x.y.z>-esc.<n> (or legacy <x.y.z>-pb.<n>) may reach the spawned command line (shell is on for win32)",
        { threw: true, isError: true, hasVersion: true, hasWord: true },
        probe(version, platform),
        "Throw an Error whose message contains the offending version text and the word 'version' unless it matches digits.digits.digits-(esc|pb).digits.",
      );
    });
  }

  it.each(["1.22.0-pb.2", "10.0.123-pb.10", "1.22.2-esc.1", "10.0.123-esc.10"])(
    "accepts the valid fork version %s on both platforms",
    (version) => {
      check(
        `bootSpawnPlan(${version})`,
        "A well-formed fork version still produces a plan",
        [{ threw: false }, { threw: false }],
        [probe(version, "win32"), probe(version, "linux")],
        "Accept <x.y.z>-esc.<n> and legacy <x.y.z>-pb.<n> with digits only.",
      );
    },
  );

  // Killing mutation: the plan args hard-code or mangle the suffix, or are not
  // exactly the shared engineLaunchArgs(version).
  it.each([
    ["1.22.2-esc.1", "win32"],
    ["1.22.2-esc.1", "linux"],
    ["1.22.0-pb.3", "win32"],
    ["1.22.0-pb.3", "linux"],
  ])(
    "bootSpawnPlan(%s, %s) args deep-equal engineLaunchArgs(version)",
    (version, platform) => {
      const v = value(
        `{ args: b.bootSpawnPlan(${JSON.stringify(version)},${JSON.stringify(platform)}).args, expected: id.engineLaunchArgs(${JSON.stringify(version)}) }`,
        "bootSpawnPlan args for esc/pb",
      ) as { args: string[]; expected: string[] };
      check(
        `bootSpawnPlan(${version}, ${platform}) args`,
        "The plan's args are the shared launch args at that version's tag",
        [
          "--allow-git=root",
          "-y",
          "-p",
          `github:emilyanderson-nice/cognigy-plugin#v${version}`,
          "cognigy-mcp",
        ],
        v.args,
        "Use engineLaunchArgs(version) from fork-identity.mjs as args.",
      );
      check(
        `bootSpawnPlan(${version}, ${platform}) equals engineLaunchArgs`,
        "Args come from the shared helper",
        v.expected,
        v.args,
        "Use engineLaunchArgs(version) from fork-identity.mjs as args.",
      );
    },
  );
});
