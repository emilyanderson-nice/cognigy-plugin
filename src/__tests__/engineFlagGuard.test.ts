import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

/**
 * Guard: npm 12 blocks `github:` specs (EALLOWGIT) unless npx is given
 * --allow-git=root. Any tracked launch of the fork engine from a github: spec
 * must therefore carry that flag. Documentation (.md) is covered by a later
 * group and is not scanned here.
 */

const ROOT = process.cwd();
const FLAG = "--allow-git=root";
const FORK_SPEC = "github:emilyanderson-nice/cognigy-plugin";

const MANIFESTS = [
  "plugin/.claude-plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.codex-plugin/mcp.json",
  "plugin/.cursor-plugin/plugin.json",
];

/** These two files DEFINE the spec and the flag; they are the source of truth. */
const DEFINES_SPEC = new Set([
  "scripts/fork-identity.mjs",
  "src/install/forkIdentity.ts",
]);

/**
 * No exclusions remain: src/config.ts and src/setup.ts are scanned like every
 * other source (their command text must carry the flag or use SETUP_COMMAND).
 * scripts/doctor.mjs takes its launch args from bootSpawnPlan/engineLaunchArgs
 * (scripts/doctor-boot.mjs), so it is scanned too.
 */

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

function trackedFiles(): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      [
        "1. WHAT FAILED: git ls-files in the repo root",
        "2. REQUIREMENT VIOLATED: the guard enumerates tracked files",
        "3. EXPECTED: exit status 0",
        `4. ACTUAL: status ${r.status}; stderr: ${(r.stderr ?? "").slice(0, 200)}`,
        "5. GUIDANCE: Run the test from a git checkout with git on PATH.",
      ].join("\n"),
    );
  }
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"));
}

const isScannedSource = (f: string): boolean =>
  (/^scripts\/.+\.(mjs|js|ts)$/.test(f) ||
    (/^src\/.+\.ts$/.test(f) && !f.includes("__tests__/"))) &&
  !DEFINES_SPEC.has(f);

/** Drop whole-line comments so prose that mentions `npx -p github:` is not a launch. */
function stripCommentLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*|#)/.test(l))
    .join("\n");
}

const OPEN = "[({";
const CLOSE = "])}";

/** Text of the innermost bracket pair that encloses `at` (brackets included). */
function enclosingContainer(code: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at - 1; i >= 0; i--) {
    if (CLOSE.includes(code[i])) depth++;
    else if (OPEN.includes(code[i])) {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++;
    else if (CLOSE.includes(code[i])) {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return null;
}

/** The quoted string (or, unquoted, the line) that holds the match at `at`. */
function enclosingString(code: string, at: number): string {
  const lineStart = code.lastIndexOf("\n", at - 1) + 1;
  const nl = code.indexOf("\n", at);
  const lineEnd = nl < 0 ? code.length : nl;
  const line = code.slice(lineStart, lineEnd);
  const rel = at - lineStart;
  let q = -1;
  for (let i = rel - 1; i >= 0; i--) {
    if ("\"'`".includes(line[i])) {
      q = i;
      break;
    }
  }
  if (q < 0) return line;
  const end = line.indexOf(line[q], rel + 1);
  return line.slice(q + 1, end < 0 ? line.length : end);
}

const hasFlagToken = (s: string): boolean =>
  s.includes(FLAG) || /ENGINE_NPX_FLAGS|engineLaunchArgs\(/.test(s);

/**
 * A "fork launch" is `-p` (quoted or bare) followed shortly by the fork github
 * spec or a helper that yields it. The flag must belong to the SAME argument
 * list as that `-p`: the same `[...]` for a quoted `"-p"` element, the same
 * quoted string or line for command text. Returns the unflagged launches'
 * argument list / command text.
 */
function unflaggedLaunches(text: string): string[] {
  const code = stripCommentLines(text);
  const launch =
    /(["'`]-p["'`]|\s-p)[\s,]*["'`]?(github:emilyanderson-nice\/cognigy-plugin|github:\$\{\s*FORK_REPO\s*\}|enginePin\(|getEngineSpec\(|ENGINE_SPEC\b)/g;
  const bad: string[] = [];
  for (const m of code.matchAll(launch)) {
    const at = m.index ?? 0;
    const isElement = /^["'`]-p["'`]$/.test(m[1]);
    const scope = isElement
      ? (enclosingContainer(code, at) ?? enclosingString(code, at))
      : enclosingString(code, at);
    if (!hasFlagToken(scope)) bad.push(scope.replace(/\s+/g, " ").trim());
  }
  return bad;
}

/** Extra files (beyond scripts/ and src/) that can launch the engine. */
const isExtraScanned = (f: string): boolean =>
  (f.startsWith("plugin/") ||
    f.startsWith(".github/") ||
    f.startsWith(".claude/")) &&
  !f.startsWith(".claude/agents") &&
  !f.startsWith(".claude/hooks") &&
  f !== ".claude/AGENTS.md";

/** File text, or null when the file is missing, unreadable or binary. */
function readText(rel: string): string | null {
  try {
    const t = readFileSync(join(ROOT, rel), "utf8");
    return t.includes("\u0000") ? null : t;
  } catch {
    return null;
  }
}

describe("detector self-check (so the guard cannot pass vacuously)", () => {
  it("flags a quoted args array with the fork spec and no flag", () => {
    check(
      "detector: array without flag",
      "A launch with -p and the fork github spec but no flag is a violation",
      1,
      unflaggedLaunches(`["-y", "-p", "${FORK_SPEC}#v1.0.0", "cognigy-mcp"]`)
        .length,
      "The scanner must report `-p` followed by the fork github: spec when no --allow-git=root is nearby.",
    );
  });

  it("flags npx command text with the fork spec and no flag", () => {
    check(
      "detector: command text without flag",
      "Shell-style command text is also a launch",
      1,
      unflaggedLaunches(`run npx -y -p ${FORK_SPEC}#v1 cognigy-mcp now`).length,
      "The scanner must report unquoted `-p <fork spec>` command text.",
    );
  });

  it("flags template-literal command text built from FORK_REPO, and accepts it when flagged", () => {
    const dollar = "$";
    const bad = `\`or run "npx -y -p github:${dollar}{FORK_REPO} cognigy-setup" to write\``;
    const good = `\`or run "npx ${FLAG} -y -p github:${dollar}{FORK_REPO} cognigy-setup" to write\``;
    check(
      "detector: template literal text",
      "Unflagged `-p github:${FORK_REPO}` text is a violation; flagged text is not",
      { bad: 1, good: 0 },
      {
        bad: unflaggedLaunches(bad).length,
        good: unflaggedLaunches(good).length,
      },
      "Make the launch pattern also match `github:${FORK_REPO}` template text.",
    );
  });

  it("accepts the same launches when the flag is present", () => {
    check(
      "detector: flagged launches pass",
      "A launch carrying --allow-git=root is compliant",
      0,
      unflaggedLaunches(
        `["${FLAG}", "-y", "-p", "${FORK_SPEC}#v1.0.0", "cognigy-mcp"]`,
      ).length +
        unflaggedLaunches(`npx ${FLAG} -y -p ${FORK_SPEC}#v1 cognigy-mcp`)
          .length,
      "The scanner must accept launches that contain --allow-git=root.",
    );
  });

  it("reports the second of two adjacent launches when only the first is flagged", () => {
    const first = `["${FLAG}", "-y", "-p", "${FORK_SPEC}#v1", "cognigy-mcp"]`;
    const second = `["-y", "-p", "${FORK_SPEC}#v1", "cognigy-mcp"]`;
    check(
      "detector: adjacent launches, first flagged only",
      "A flag in the neighbouring array does not cover this launch",
      [second.replace(/\s+/g, " ")],
      unflaggedLaunches(`${first},\n${second}`),
      "Bind the flag to the same `[...]` as `-p <spec>`; report the unflagged array.",
    );
  });

  it("reports a launch whose flag sits in a different array or string nearby", () => {
    const arr = `const a = ["${FLAG}"];\nconst b = ["-y", "-p", "${FORK_SPEC}", "cognigy-mcp"];`;
    const str = `const a = "npx ${FLAG} -y -p x"; const b = "npx -y -p ${FORK_SPEC} cognigy-mcp";`;
    check(
      "detector: flag in a different array/string",
      "The flag must be in the same argument list or command string",
      {
        arr: [`["-y", "-p", "${FORK_SPEC}", "cognigy-mcp"]`],
        str: [`npx -y -p ${FORK_SPEC} cognigy-mcp`],
      },
      { arr: unflaggedLaunches(arr), str: unflaggedLaunches(str) },
      "Scope the flag check to the enclosing array / quoted string, not a character window.",
    );
  });

  it("accepts a flag anywhere in the same array, and the shared-helper forms", () => {
    check(
      "detector: same-array flag and helpers accepted",
      "Same-array flag (before or after -p), ...ENGINE_NPX_FLAGS and ...engineLaunchArgs() count",
      0,
      unflaggedLaunches(`["-y", "-p", "${FORK_SPEC}", "${FLAG}"]`).length +
        unflaggedLaunches(`[...ENGINE_NPX_FLAGS,"-y","-p",ENGINE_SPEC]`)
          .length +
        unflaggedLaunches(`[...engineLaunchArgs(), "-y", "-p", ENGINE_SPEC]`)
          .length,
      "Accept the flag token or helper when it is an element of the same array.",
    );
  });

  it("does not flag registry-spec launches or comment prose", () => {
    check(
      "detector: registry spec and comments are not violations",
      "npm registry specs do not need the git flag; commented prose is not a launch",
      0,
      unflaggedLaunches(
        `npx -y -p @cognigy/plugin-engine@latest cognigy-mcp\n["-y","-p","@cognigy/plugin-engine@latest","cognigy-mcp"]\n// npx -y -p ${FORK_SPEC}#v1 cognigy-mcp\n * npx -p ${FORK_SPEC} cognigy-mcp`,
      ).length,
      "Only github: fork specs (or helpers that return them) count; skip comment-only lines.",
    );
  });
});

describe("engine launches from github: carry --allow-git=root", () => {
  const files = trackedFiles();

  it("the guard sees all four manifests and a non-trivial set of sources", () => {
    const sources = files.filter(isScannedSource);
    check(
      "guard coverage",
      "The scan must actually cover the manifests and the scripts/src sources",
      { manifests: MANIFESTS.length, enoughSources: true },
      {
        manifests: MANIFESTS.filter((m) => files.includes(m)).length,
        enoughSources: sources.length >= 20,
      },
      "Keep the four manifests tracked and scan scripts/ and non-test src/ files.",
    );
  });

  it.each(MANIFESTS)("%s: platform args carry --allow-git=root", (rel) => {
    const args: string[] = JSON.parse(readFileSync(join(ROOT, rel), "utf8"))
      .mcpServers.platform.args;
    const p = args.indexOf("-p");
    const fork = p >= 0 && String(args[p + 1]).startsWith(FORK_SPEC);
    check(
      `${rel} launches the fork from github:`,
      "Fixture sanity: the manifest launches the fork engine from a github: spec",
      true,
      fork,
      "The platform server args must still be -p <fork github spec>.",
    );
    check(
      `${rel} args include the flag`,
      "npm 12 blocks github: specs unless --allow-git=root is passed to npx",
      true,
      args.includes(FLAG),
      "Add --allow-git=root to this manifest's platform args (as the first element).",
    );
  });

  it("no tracked script or source builds a fork github: launch without the flag", () => {
    const offenders: Record<string, string[]> = {};
    for (const f of files.filter(isScannedSource)) {
      const bad = unflaggedLaunches(readFileSync(join(ROOT, f), "utf8"));
      if (bad.length > 0) offenders[f] = bad;
    }
    check(
      "unflagged fork launches in scripts/ and src/",
      "Every `-p <fork github: spec>` launch must also carry --allow-git=root (or build its args from the shared engine launch helpers)",
      {},
      offenders,
      "In each listed file, pass --allow-git=root first or build the args from the shared ENGINE_NPX_FLAGS / engineLaunchArgs helpers.",
    );
  });

  it("also scans tracked plugin/, .github/ and .claude/ files (text only)", () => {
    const extra = files.filter(isExtraScanned);
    const offenders: Record<string, string[]> = {};
    for (const f of extra) {
      const t = readText(f);
      if (t === null) continue;
      const bad = unflaggedLaunches(t);
      if (bad.length > 0) offenders[f] = bad;
    }
    check(
      "coverage and unflagged fork launches in plugin/, .github/, .claude/",
      "The scan covers the manifests and every `-p <fork github: spec>` launch there carries --allow-git=root",
      { coversManifests: true, offenders: {} },
      {
        coversManifests: MANIFESTS.every((m) => extra.includes(m)),
        offenders,
      },
      "Add --allow-git=root to the same argument list / command string as -p <spec> in each listed file.",
    );
  });
});
