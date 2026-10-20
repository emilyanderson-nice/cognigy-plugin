import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

/**
 * Docs and user-facing text: npm 12 blocks `github:` specs (EALLOWGIT) unless
 * npx is given --allow-git=root. Every documented command that runs the FORK
 * from GitHub must read `npx --allow-git=root -y -p github:...`. Commands that
 * run Cognigy's registry package must NOT carry the flag.
 */

const ROOT = process.cwd();
const FLAG = "--allow-git=root";
const FORK = "emilyanderson-nice/cognigy-plugin";

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
  const out = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"));
}

const isDocFile = (f: string): boolean =>
  (/\.md$/.test(f) &&
    f !== "CHANGELOG.md" &&
    !f.startsWith("docs/platform-versions/")) ||
  f === "install.sh" ||
  f === "install.ps1";

/**
 * Join shell line continuations (a trailing ` \` for bash, a trailing ` ` + backtick
 * for PowerShell) into one logical line, remembering each one's first line number.
 * The marker must follow whitespace so a closing inline-code backtick is not one.
 */
function logicalLines(text: string): { line: number; text: string }[] {
  const raw = text.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    let cur = raw[i];
    const start = i + 1;
    while (/\s(?:\\|`)\s*$/.test(cur) && i + 1 < raw.length) {
      cur = `${cur.replace(/\s*(?:\\|`)\s*$/, "")} ${raw[i + 1].trimStart()}`;
      i++;
    }
    out.push({ line: start, text: cur });
  }
  return out;
}

/**
 * Every `npx ... (-p|--package)[=| ]github:<fork>` command in the text (after
 * joining continuations). A command is compliant only when it starts
 * `npx --allow-git=root ` and no flag appears after the package option.
 */
function unflaggedCommands(text: string): string[] {
  const re = new RegExp(
    `npx(?:\\s+(?!npx\\b)\\S+)*?\\s+(?:-p|--package)(?:=|\\s+)["'\`]?github:${FORK.replace("/", "\\/")}\\S*(?:\\s+\\S+){0,2}`,
    "g",
  );
  const bad: string[] = [];
  for (const { text: line } of logicalLines(text)) {
    for (const m of line.matchAll(re)) {
      const cmd = m[0];
      const opt = cmd.search(/\s(?:-p|--package)(?:=|\s)/);
      const startsRight = cmd.startsWith(`npx ${FLAG} `);
      const flagAfterOption = cmd.slice(opt).includes("--allow-git");
      if (!startsRight || flagAfterOption) bad.push(cmd);
    }
  }
  return bad;
}

function offenders(
  files: string[],
): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    for (const { line, text } of logicalLines(
      readFileSync(join(ROOT, f), "utf8"),
    )) {
      if (unflaggedCommands(text).length > 0)
        found.push({ file: f, line, text: text.trim().slice(0, 160) });
    }
  }
  return found;
}

describe("docs detector self-check (so the scan cannot pass vacuously)", () => {
  it("accepts a correctly flagged fork command", () => {
    check(
      "detector: flagged line accepted",
      "`npx --allow-git=root -y -p github:<fork> bin` is compliant",
      0,
      unflaggedCommands(
        `Run \`npx ${FLAG} -y -p github:${FORK}#v1.2.3 cognigy-setup\` now`,
      ).length,
      "The detector must accept flag-first, then -y.",
    );
  });

  it("rejects an unflagged fork command, a wrong order and a flag after -p", () => {
    check(
      "detector: unflagged line rejected",
      "Missing flag is a violation",
      1,
      unflaggedCommands(`npx -y -p github:${FORK} cognigy-setup`).length,
      "Report `npx -y -p github:<fork>` with no flag.",
    );
    check(
      "detector: -y before flag rejected",
      "Flag must come immediately after npx",
      1,
      unflaggedCommands(`npx -y ${FLAG} -p github:${FORK} cognigy-setup`)
        .length,
      "Report when the flag is not directly after npx.",
    );
    check(
      "detector: flag after -p rejected",
      "Flag after -p is not an npx flag",
      1,
      unflaggedCommands(`npx -y -p github:${FORK} ${FLAG} cognigy-setup`)
        .length,
      "Report when the flag follows -p.",
    );
  });

  it("ignores registry specs and table cells without npx", () => {
    check(
      "detector: registry and npx-less lines ignored",
      "Only fork github: commands need the flag",
      0,
      unflaggedCommands("npx -y -p @cognigy/plugin-engine@latest cognigy-setup")
        .length +
        unflaggedCommands(`| engine | -p github:${FORK}#v1 |`).length +
        unflaggedCommands(
          "npx -y --package=@cognigy/plugin-engine@latest cognigy-setup",
        ).length,
      "Ignore registry specs (any option form) and lines lacking npx.",
    );
  });

  it("judges a backslash-continued command as one command", () => {
    check(
      "detector: bash continuation, unflagged and flagged",
      "`npx -y \\<newline> -p github:<fork>` is one command and needs the flag",
      { bad: 1, good: 0 },
      {
        bad: unflaggedCommands(`npx -y \\\n  -p github:${FORK} cognigy-setup`)
          .length,
        good: unflaggedCommands(
          `npx ${FLAG} -y \\\n  -p github:${FORK} cognigy-setup`,
        ).length,
      },
      "Join lines ending in a backslash before scanning.",
    );
  });

  it("judges a PowerShell backtick-continued command as one command", () => {
    const tick = "`";
    check(
      "detector: PowerShell continuation, unflagged and flagged",
      "A trailing backtick continues the command; the joined command needs the flag",
      { bad: 1, good: 0 },
      {
        bad: unflaggedCommands(
          `npx -y ${tick}\n  -p github:${FORK} cognigy-setup`,
        ).length,
        good: unflaggedCommands(
          `npx ${FLAG} -y ${tick}\n  -p github:${FORK} cognigy-setup`,
        ).length,
      },
      "Join lines ending in a whitespace-preceded backtick before scanning.",
    );
  });

  it("judges the --package=, --package and -p= forms too", () => {
    check(
      "detector: alternative package option forms",
      "`--package=github:<fork>`, `--package github:<fork>` and `-p=github:<fork>` need the flag like -p does",
      { eqBad: 1, spBad: 1, pEqBad: 1, eqGood: 0, spGood: 0, pEqGood: 0 },
      {
        eqBad: unflaggedCommands(
          `npx -y --package=github:${FORK}#v1 cognigy-setup`,
        ).length,
        spBad: unflaggedCommands(
          `npx -y --package github:${FORK}#v1 cognigy-setup`,
        ).length,
        pEqBad: unflaggedCommands(`npx -y -p=github:${FORK}#v1 cognigy-setup`)
          .length,
        eqGood: unflaggedCommands(
          `npx ${FLAG} -y --package=github:${FORK}#v1 cognigy-setup`,
        ).length,
        spGood: unflaggedCommands(
          `npx ${FLAG} -y --package github:${FORK}#v1 cognigy-setup`,
        ).length,
        pEqGood: unflaggedCommands(
          `npx ${FLAG} -y -p=github:${FORK}#v1 cognigy-setup`,
        ).length,
      },
      "Match `(-p|--package)` followed by `=` or whitespace, then the fork spec.",
    );
  });
});

describe("documented fork commands carry --allow-git=root", () => {
  const files = trackedFiles().filter(isDocFile);

  it("scans a non-trivial doc set including README.md and the install scripts", () => {
    check(
      "doc scan coverage",
      "The scan must include README.md, install.sh and install.ps1",
      { readme: true, sh: true, ps1: true, many: true },
      {
        readme: files.includes("README.md"),
        sh: files.includes("install.sh"),
        ps1: files.includes("install.ps1"),
        many: files.length >= 5,
      },
      "Keep these files tracked.",
    );
  });

  it("no tracked doc or install script shows an unflagged fork npx command", () => {
    check(
      "unflagged fork npx commands in docs (file:line)",
      "Every `npx -y -p github:<fork>` must read `npx --allow-git=root -y -p github:<fork>`",
      [],
      offenders(files).map((o) => `${o.file}:${o.line}: ${o.text}`),
      "Insert --allow-git=root directly after npx on each listed line.",
    );
  });
});

describe("install scripts still run the registry package without the flag", () => {
  it('install.sh executes `npx -y -p "$PKG" cognigy-setup` with no --allow-git', () => {
    const lines = readFileSync(join(ROOT, "install.sh"), "utf8")
      .split(/\r?\n/)
      .filter((l) => /npx\b.*\$PKG.*cognigy-setup/.test(l));
    check(
      "install.sh registry execution line",
      "The executed line exists and carries no git flag",
      { count: 1, flagged: false },
      {
        count: lines.length,
        flagged: lines.some((l) => l.includes("--allow-git")),
      },
      'Keep exec npx -y -p "$PKG" cognigy-setup unflagged; PKG is the registry package.',
    );
  });

  it("install.ps1 executes the registry package ($Pkg) with no --allow-git", () => {
    const lines = readFileSync(join(ROOT, "install.ps1"), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^\s*&?\s*npx\b.*\$Pkg/i.test(l));
    check(
      "install.ps1 registry execution line",
      "The executed line exists and carries no git flag",
      { count: 1, flagged: false },
      {
        count: lines.length,
        flagged: lines.some((l) => l.includes("--allow-git")),
      },
      "Keep & npx -y -p $Pkg cognigy-setup unflagged.",
    );
  });
});

describe("README troubleshooting and cold-start figures", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  function troubleshootingSection(text: string): string {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^#{1,6}\s.*troubleshoot/i.test(l));
    if (start < 0) return "";
    const level = (lines[start].match(/^#+/) as RegExpMatchArray)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = lines[i].match(/^(#{1,6})\s/);
      if (h && h[1].length <= level) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }

  it("has a troubleshooting section covering EALLOWGIT, allow-git, the flag and 2 minutes", () => {
    const section = troubleshootingSection(readme);
    check(
      "README troubleshooting section content",
      "Users hitting npm 12's EALLOWGIT or a slow first start need the cause and fix",
      {
        EALLOWGIT: true,
        "allow-git": true,
        "--allow-git=root": true,
        "2 minutes": true,
      },
      {
        EALLOWGIT: section.includes("EALLOWGIT"),
        "allow-git": section.includes("allow-git"),
        "--allow-git=root": section.includes("--allow-git=root"),
        "2 minutes": section.includes("2 minutes"),
      },
      "Add a heading containing 'Troubleshooting' to README.md whose section mentions all four terms.",
    );
  });

  it("names the versions and date of the checks, and labels the root semantics as documented", () => {
    const section = troubleshootingSection(readme);
    check(
      "README troubleshooting evidence",
      "Claims about npm 12 behaviour carry their evidence: versions checked, the date, and the evidence class",
      {
        "12.2.0": true,
        "10.9.9": true,
        "11.21.1": true,
        "2026-10-20": true,
        documentedWord: true,
        "as documented": true,
      },
      {
        "12.2.0": section.includes("12.2.0"),
        "10.9.9": section.includes("10.9.9"),
        "11.21.1": section.includes("11.21.1"),
        "2026-10-20": section.includes("2026-10-20"),
        documentedWord:
          /\bdocumented\b/.test(section) ||
          section.includes("npm's documentation"),
        "as documented": section.includes("as documented"),
      },
      "In the Troubleshooting section name npm 12.2.0, 10.9.9 and 11.21.1, the date 2026-10-20, and phrase the `root` semantics as documented (cite npm's documentation), not as bare fact.",
    );
  });

  const STALE: [string, RegExp][] = [
    ["20-30 s/seconds", /20\s*[-–]\s*30\s*(s\b|seconds)/],
    ["~22-30s", /~\s*22-30s/],
    ["~30s", /~30s/],
  ];

  it("no doc still claims the old 20-30 s cold start", () => {
    const files = trackedFiles().filter(
      (f) =>
        f === "README.md" ||
        f === "docs/TESTING.md" ||
        f === "MAINTAINING.md" ||
        /^docs\/install\/[^/]+\.md$/.test(f),
    );
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), "utf8")
        .split(/\r?\n/)
        .forEach((text, i) => {
          for (const [label, re] of STALE)
            if (re.test(text)) hits.push(`${f}:${i + 1} [${label}]`);
        });
    }
    check(
      "stale cold-start figures (file:line)",
      "A cold start measured 110-150 s; docs must not claim 20-30 s",
      [],
      hits,
      "Replace each listed figure with the measured cold start (about 2 minutes).",
    );
  });
});

describe("MAINTAINING.md stays true without upkeep", () => {
  const text = readFileSync(join(ROOT, "MAINTAINING.md"), "utf8");

  it("does not state the current fork version in prose (it goes stale on every bump)", () => {
    const m = text.match(/currently\s+`\d+\.\d+\.\d+-pb\.\d+`/);
    check(
      "MAINTAINING.md hard-coded current version",
      "The version is owned by package.json and release tooling; prose must not say 'currently `x.y.z-pb.n`'",
      null,
      m ? m[0] : null,
      "Reword to refer to package.json instead of naming the current version.",
    );
  });

  it("does not claim figures were 'measured before the tag pin'", () => {
    check(
      "MAINTAINING.md contradictory measurement claim",
      "The boot times were measured with the tag pin; saying they predate it contradicts the table",
      false,
      text.includes("measured before the tag pin"),
      "Remove or correct the sentence so it matches the table (measured with the tag pin).",
    );
  });

  it("boot-time table has a Warm row that does not say ~3s", () => {
    const row = text.split(/\r?\n/).find((l) => /^\|\s*Warm\s*\|/.test(l));
    check(
      "MAINTAINING.md warm boot row",
      "The Warm row exists and must not reintroduce the unmeasured ~3s figure",
      { found: true, hasThreeSeconds: false },
      {
        found: row !== undefined,
        hasThreeSeconds: (row ?? "").includes("~3s"),
      },
      "Keep the Warm row with the measured figure.",
    );
  });
});

describe("src/setup.ts header comment", () => {
  it("shows the flagged fork command and no unflagged variant", () => {
    const text = readFileSync(join(ROOT, "src/setup.ts"), "utf8");
    const header = text.slice(0, text.indexOf("*/") + 2);
    check(
      "setup.ts header",
      "The documented run command must include --allow-git=root",
      { flagged: true, unflagged: false },
      {
        flagged: header.includes(
          "npx --allow-git=root -y -p github:<fork repo> cognigy-setup",
        ),
        unflagged: /npx -y -p github:/.test(header),
      },
      "Change the header to `npx --allow-git=root -y -p github:<fork repo> cognigy-setup`.",
    );
  });
});
