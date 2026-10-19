import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = process.cwd();
const SRC_DIR = join(REPO_ROOT, "src");
const FORK_IDENTITY = "src/install/forkIdentity.ts";

/** Fail with five labelled lines so a reader without the test source can act. */
function fail(
  testName: string,
  requirement: string,
  expected: string,
  actual: unknown,
  guidance: string,
): never {
  throw new Error(
    [
      `1. WHAT FAILED: ${testName}`,
      `2. REQUIREMENT VIOLATED: ${requirement}`,
      `3. EXPECTED: ${expected}`,
      `4. ACTUAL: ${JSON.stringify(actual)}`,
      `5. GUIDANCE: ${guidance}`,
    ].join("\n"),
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

const files: string[] = [];
walk(SRC_DIR, files);

const sources = files.map((f) => ({
  rel: relative(REPO_ROOT, f).split(sep).join("/"),
  text: readFileSync(f, "utf8"),
}));

function offenders(pred: (text: string) => boolean, skip?: string): string[] {
  return sources
    .filter((s) => s.rel !== skip && pred(s.text))
    .map((s) => s.rel)
    .sort();
}

function expectNone(
  testName: string,
  requirement: string,
  found: string[],
  guidance: string,
): void {
  if (found.length > 0) {
    fail(testName, requirement, "no offending files ([])", found, guidance);
  }
}

describe("no upstream identity hard-coded in non-test src files", () => {
  it("scan covers at least 20 files including setup.ts and install/codex.ts", () => {
    const rels = sources.map((s) => s.rel);
    if (
      rels.length < 20 ||
      !rels.includes("src/setup.ts") ||
      !rels.includes("src/install/codex.ts")
    ) {
      fail(
        "source scan coverage",
        "The scan must actually see the source tree, otherwise the other assertions pass vacuously",
        ">= 20 files, including src/setup.ts and src/install/codex.ts",
        {
          count: rels.length,
          hasSetup: rels.includes("src/setup.ts"),
          hasCodex: rels.includes("src/install/codex.ts"),
        },
        "Scan src/ recursively from the repo root (excluding src/__tests__) for .ts files.",
      );
    }
    expect(rels.length).toBeGreaterThanOrEqual(20);
  });

  it("no file contains the upstream repo slug", () => {
    expectNone(
      "no 'Cognigy/cognigy-plugin' literal in src",
      "The fork's repo identity comes from src/install/forkIdentity.ts, never the upstream slug",
      offenders((t) => t.includes("Cognigy/cognigy-plugin")),
      "Replace each occurrence in the listed files with the fork identity imported from the single forkIdentity module.",
    );
  });

  it("no file contains the upstream plugin selector", () => {
    expectNone(
      "no 'cognigy@cognigy-plugin' selector (without -v2) in src",
      "The plugin selector must be the fork's, not upstream's cognigy@cognigy-plugin",
      offenders((t) => /cognigy@cognigy-plugin(?!-v2)/.test(t)),
      "Use the fork plugin id and marketplace name exported by the forkIdentity module instead of a literal selector.",
    );
  });

  it("no file contains the pb-crackers literal", () => {
    expectNone(
      "no 'pb-crackers' literal in src",
      "Intermediate-upstream owner names must not appear in source",
      offenders((t) => t.includes("pb-crackers")),
      "Remove the owner name from the listed files; derive repo references from the fork identity module.",
    );
  });

  it("forkIdentity.ts defines the fork slug exactly once", () => {
    const fi = sources.find((s) => s.rel === FORK_IDENTITY);
    const count = fi
      ? fi.text.split("emilyanderson-nice/cognigy-plugin").length - 1
      : 0;
    if (count !== 1) {
      fail(
        "single definition of the fork slug",
        "The fork slug is defined in exactly one place",
        `${FORK_IDENTITY} contains "emilyanderson-nice/cognigy-plugin" exactly once`,
        { fileFound: Boolean(fi), occurrences: count },
        "Define the slug once in the forkIdentity module and derive any other forms (URLs, ids) from that constant.",
      );
    }
    expect(count).toBe(1);
  });

  it("the npm package literal appears only in the Desktop/Antigravity install paths", () => {
    const allowed = [
      "src/install/antigravity.ts",
      "src/install/claudeDesktop.ts",
      "src/install/desktopLauncher.ts",
    ];
    const found = offenders((t) => t.includes("@cognigy/plugin-engine")).filter(
      (rel) => !allowed.includes(rel),
    );
    if (found.length > 0) {
      fail(
        "no '@cognigy/plugin-engine' literal outside the Desktop/Antigravity paths",
        "Only the paths that still fetch the published engine may name the upstream npm package",
        `the literal appears only in ${allowed.join(", ")}`,
        found,
        "Replace the literal in the listed files with the fork engine source from the forkIdentity module.",
      );
    }
    expect(found).toEqual([]);
  });

  it("no other file mentions the fork owner literally", () => {
    expectNone(
      "no 'emilyanderson-nice' literal outside forkIdentity.ts",
      "Every other file consumes the fork identity via import rather than repeating the owner name",
      offenders((t) => t.includes("emilyanderson-nice"), FORK_IDENTITY),
      "Import the repo, plugin id and marketplace name constants from the forkIdentity module in the listed files.",
    );
  });
});
