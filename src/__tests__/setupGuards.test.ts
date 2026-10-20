import { describe, it, expect } from "@jest/globals";
import { jest } from "@jest/globals";
import { join, parse, resolve, sep } from "node:path";
import * as setupModule from "../setup.js";

// Namespace import so a missing export fails each test alone instead of
// aborting the suite at link time (same technique as installPlan.test.ts).
const mod = setupModule as unknown as {
  rejectProjectFlag: (subcommand: string, argv: string[]) => string | undefined;
  projectDirProblem: (
    cwd: string,
    home: string,
    exists: (path: string) => boolean,
  ) => { refuse?: string; warn?: string } | undefined;
  projectInstallSummary: (cwd: string) => string;
};
const rejectProjectFlag = (s: string, a: string[]) =>
  mod.rejectProjectFlag(s, a);
const projectDirProblem = (
  cwd: string,
  home: string,
  exists: (p: string) => boolean,
) => mod.projectDirProblem(cwd, home, exists);
const projectInstallSummary = (cwd: string) => mod.projectInstallSummary(cwd);

/** Fail with five labelled lines so a reader without the test source can act. */
function check(
  testName: string,
  requirement: string,
  expected: unknown,
  actual: unknown,
  guidance: string,
  mode: "equal" | "contains" | "excludes" = "equal",
): void {
  try {
    if (mode === "contains") {
      expect(String(actual)).toContain(String(expected));
    } else if (mode === "excludes") {
      expect(String(actual)).not.toContain(String(expected));
    } else {
      expect(actual).toEqual(expected);
    }
  } catch {
    const label =
      mode === "contains"
        ? " (substring)"
        : mode === "excludes"
          ? " (must NOT contain)"
          : "";
    throw new Error(
      [
        `1. WHAT FAILED: ${testName}`,
        `2. REQUIREMENT VIOLATED: ${requirement}`,
        `3. EXPECTED${label}: ${JSON.stringify(expected)}`,
        `4. ACTUAL: ${JSON.stringify(actual)}`,
        `5. GUIDANCE: ${guidance}`,
      ].join("\n"),
    );
  }
}

const EXACT_COMMAND =
  "claude plugin uninstall cognigy@cognigy-plugin-v2 --scope project";

describe("rejectProjectFlag", () => {
  for (const sub of ["uninstall", "update", "status"]) {
    it(`${sub} with --project: text names the flag, the subcommand and the exact manual command`, () => {
      const text = rejectProjectFlag(sub, ["--project"]);
      check(
        `rejectProjectFlag('${sub}', ['--project']): is text`,
        "--project is not valid for this subcommand, so a message is returned",
        "string",
        typeof text,
        "Return a string explaining the flag is rejected.",
      );
      check(
        `rejectProjectFlag('${sub}'): flag named`,
        "The message names the offending flag",
        "--project",
        text,
        "Mention --project in the text.",
        "contains",
      );
      check(
        `rejectProjectFlag('${sub}'): subcommand named`,
        "The message names the subcommand that rejected it",
        sub,
        text,
        "Interpolate the subcommand name into the text.",
        "contains",
      );
      check(
        `rejectProjectFlag('${sub}'): manual command`,
        "The message gives the exact manual project-scope command",
        EXACT_COMMAND,
        text,
        "Include the command verbatim so the user can copy it.",
        "contains",
      );
    });

    it(`${sub} without --project returns undefined`, () => {
      check(
        `rejectProjectFlag('${sub}', [])`,
        "No flag, no rejection",
        undefined,
        rejectProjectFlag(sub, []),
        "Return undefined when argv lacks --project.",
      );
    });

    it(`${sub} with other flags mixed in: rejects only when --project is present`, () => {
      const mixed = ["--yes", "--client", "claude-code"];
      check(
        `rejectProjectFlag('${sub}', other flags only)`,
        "Other flags never trigger the rejection",
        undefined,
        rejectProjectFlag(sub, mixed),
        "Look for the exact token --project only.",
      );
      const text = rejectProjectFlag(sub, [...mixed, "--project"]);
      check(
        `rejectProjectFlag('${sub}', other flags + --project)`,
        "--project is detected anywhere in argv",
        EXACT_COMMAND,
        text,
        "Search the whole argv for --project.",
        "contains",
      );
    });
  }

  it("the message names the subcommand it was called with, not a constant", () => {
    const a = String(rejectProjectFlag("update", ["--project"]));
    check(
      "rejectProjectFlag('update'): does not say uninstall as the subcommand",
      "The subcommand shown is the one passed in",
      "update",
      a,
      "Use the subcommand parameter in the message.",
      "contains",
    );
    const s = String(rejectProjectFlag("status", ["--project"]));
    check(
      "rejectProjectFlag('status'): differs from update",
      "Different subcommands yield different text",
      false,
      a === s,
      "Interpolate the subcommand name.",
    );
  });

  for (const sub of ["install", "profile", "frobnicate"]) {
    it(`${sub} is not guarded: undefined even with --project`, () => {
      check(
        `rejectProjectFlag('${sub}', ['--project', '--yes'])`,
        "Only uninstall, update and status reject --project",
        undefined,
        rejectProjectFlag(sub, ["--project", "--yes"]),
        "Return undefined for every other subcommand.",
      );
    });
  }
});

describe("projectDirProblem", () => {
  const base = resolve(sep, "work-guard-test");
  const home = join(base, "home", "someone");
  const proj = join(base, "projects", "demo");
  const GIT = join(proj, ".git");
  const CLAUDE = join(proj, ".claude");

  const existsOnly = (...present: string[]) =>
    jest.fn<(p: string) => boolean>((p) => present.includes(p));

  it("cwd equal to home: refuse mentioning the home folder, and only refuse", () => {
    const r = projectDirProblem(home, home, existsOnly(join(home, ".git")));
    check(
      "projectDirProblem(home, home): keys",
      "Home is refused outright, never merely warned about",
      ["refuse"],
      r ? Object.keys(r) : r,
      "Return { refuse } only, even when .git exists in home.",
    );
    check(
      "projectDirProblem(home, home): text",
      "The refusal says why",
      "home folder",
      r?.refuse,
      "Mention 'home folder' in the refuse text.",
      "contains",
    );
  });

  it("cwd equal to home except for a trailing separator: still refused", () => {
    const r = projectDirProblem(home + sep, home, existsOnly());
    check(
      "projectDirProblem(home + sep, home)",
      "Paths are compared after normalisation",
      "home folder",
      r?.refuse,
      "Compare path.resolve(cwd) with path.resolve(home).",
      "contains",
    );
    const r2 = projectDirProblem(home, home + sep, existsOnly());
    check(
      "projectDirProblem(home, home + sep)",
      "Normalisation applies to both arguments",
      "home folder",
      r2?.refuse,
      "Resolve both paths before comparing.",
      "contains",
    );
  });

  const winIt = process.platform === "win32" ? it : it.skip;
  winIt("Windows: a case-only difference from home is still refused", () => {
    const r = projectDirProblem(home.toUpperCase(), home, existsOnly());
    check(
      "projectDirProblem(HOME upper-cased, home) on win32",
      "Windows paths are case-insensitive",
      "home folder",
      r?.refuse,
      "Lower-case both resolved paths on win32 before comparing.",
      "contains",
    );
  });

  it("a different directory under home is not refused as home", () => {
    const r = projectDirProblem(
      join(home, "repo"),
      home,
      existsOnly(join(home, "repo", ".git")),
    );
    check(
      "projectDirProblem(home/repo, home)",
      "Only the home folder itself is refused",
      undefined,
      r,
      "Compare for equality, not prefix.",
    );
  });

  it("cwd equal to its filesystem root: refuse mentioning the filesystem root", () => {
    const root = parse(proj).root;
    const r = projectDirProblem(root, home, existsOnly(join(root, ".git")));
    check(
      "projectDirProblem(root, home): keys",
      "A filesystem root is refused outright",
      ["refuse"],
      r ? Object.keys(r) : r,
      "Return { refuse } only.",
    );
    check(
      "projectDirProblem(root, home): text",
      "The refusal says why",
      "filesystem root",
      r?.refuse,
      "Mention 'filesystem root' in the refuse text.",
      "contains",
    );
  });

  it("home folder text and root text are distinct messages", () => {
    const root = parse(proj).root;
    const a = projectDirProblem(home, home, existsOnly())?.refuse;
    const b = projectDirProblem(root, home, existsOnly())?.refuse;
    check(
      "refuse texts differ",
      "Each refusal reason has its own wording",
      false,
      String(a).includes("filesystem root") ||
        String(b).includes("home folder"),
      "Do not mix the two reasons in one message.",
    );
  });

  it(".git present: no problem, and .git is the path asked about", () => {
    const exists = existsOnly(GIT);
    check(
      "projectDirProblem(proj, home, .git exists)",
      "A git checkout is a project root",
      undefined,
      projectDirProblem(proj, home, exists),
      "Return undefined when join(cwd, '.git') exists.",
    );
    const asked = exists.mock.calls.map((c) => c[0]);
    check(
      "exists was asked about .git",
      "The .git path under cwd is probed",
      true,
      asked.includes(GIT),
      "Call exists(path.join(cwd, '.git')).",
    );
    check(
      "exists asked only about .git/.claude under cwd",
      "No other path is probed",
      [],
      asked.filter((p) => p !== GIT && p !== CLAUDE),
      "Probe only .git and .claude under cwd.",
    );
  });

  it(".claude present (no .git): no problem", () => {
    const exists = existsOnly(CLAUDE);
    check(
      "projectDirProblem(proj, home, .claude exists)",
      "An existing .claude folder marks a project root",
      undefined,
      projectDirProblem(proj, home, exists),
      "Return undefined when join(cwd, '.claude') exists.",
    );
    const asked = exists.mock.calls.map((c) => c[0]);
    check(
      ".claude path probed",
      "The .claude path under cwd is probed",
      true,
      asked.includes(CLAUDE),
      "Call exists(path.join(cwd, '.claude')).",
    );
  });

  it("neither present: warn only, with the documented wording, probing exactly both paths", () => {
    const exists = existsOnly();
    const r = projectDirProblem(proj, home, exists);
    check(
      "projectDirProblem(proj, home, nothing exists): keys",
      "A non-project directory is a warning, never a refusal",
      ["warn"],
      r ? Object.keys(r) : r,
      "Return { warn } with no refuse key.",
    );
    check(
      "projectDirProblem(proj, home, nothing exists): text",
      "The warning says the folder is not a project root",
      "does not look like a project root",
      r?.warn,
      "Use the phrase 'does not look like a project root'.",
      "contains",
    );
    check(
      "exists probed exactly .git and .claude under cwd",
      "Both markers are checked, nothing else",
      [CLAUDE, GIT].sort(),
      exists.mock.calls.map((c) => c[0]).sort(),
      "Call exists once for each of join(cwd,'.git') and join(cwd,'.claude').",
    );
  });
});

describe("projectInstallSummary", () => {
  const cwd = join(resolve(sep, "work-guard-test"), "projects", "demo");

  it("states the folder, the settings file, the credential store and the trust prompt", () => {
    const text = projectInstallSummary(cwd);
    check(
      "summary contains cwd",
      "The user sees which folder is being changed",
      cwd,
      text,
      "Interpolate cwd verbatim.",
      "contains",
    );
    check(
      "summary names the settings file",
      "The user sees which file is written",
      ".claude/settings.json",
      text,
      "Write the literal '.claude/settings.json' (forward slash).",
      "contains",
    );
    check(
      "summary names the credential store",
      "The user is told where the key lives",
      "credential store",
      text,
      "Say the key goes to the credential store.",
      "contains",
    );
    check(
      "summary warns about the trust prompt",
      "The user is told Claude Code may prompt for trust",
      "may ask you to trust",
      text,
      "Use the phrase 'may ask you to trust'.",
      "contains",
    );
  });

  it("follows the cwd it is given", () => {
    const other = join(resolve(sep, "work-guard-test"), "elsewhere");
    check(
      "summary for another cwd",
      "The folder shown is the argument, not a constant",
      other,
      projectInstallSummary(other),
      "Use the cwd parameter.",
      "contains",
    );
    check(
      "summary for another cwd drops the first cwd",
      "No stale folder leaks into the text",
      cwd,
      projectInstallSummary(other),
      "Do not cache or hard-code the folder.",
      "excludes",
    );
  });

  it("never mentions the user-scope credentials file, the old trust phrasing or the key variable", () => {
    for (const dir of [cwd, join(cwd, "nested")]) {
      const text = projectInstallSummary(dir);
      check(
        "summary excludes ~/.cognigy-plugin/config.json",
        "Project installs do not use the user-scope credentials file",
        "~/.cognigy-plugin/config.json",
        text,
        "Remove that path from the project summary.",
        "excludes",
      );
      check(
        "summary excludes old trust phrasing",
        "Wording is 'may ask you to trust', not a certainty",
        "asks you to trust the project settings",
        text,
        "Use the hedged phrase only.",
        "excludes",
      );
      check(
        "summary excludes COGNIGY_API_KEY",
        "The summary never names the key variable",
        "COGNIGY_API_KEY",
        text,
        "Do not mention the environment variable.",
        "excludes",
      );
    }
  });
});
