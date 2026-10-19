#!/usr/bin/env node
/**
 * Resolve the boilerplate half of an upstream merge.
 *
 * Every merge (from the previous fork or from Cognigy) conflicts on the same
 * manifest files, always the same way: take the incoming version number, keep
 * this fork's `github:` engine spec. Doing that by hand each time is tedious
 * and — more to the point — one slip restores the npm engine and the fork
 * silently stops running. The resolution rules live in merge-resolution.mjs.
 *
 * This resolves ONLY those manifest/version conflicts and re-stamps the fork
 * version. Conflicts in source files are left alone: they need judgement, and
 * quietly picking a side there is how a merge loses a feature.
 *
 * Usage, after `git merge <source>` reports conflicts:
 *   npm run merge:resolve
 *   # then resolve any remaining source conflicts by hand
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countHunks, resolveManifestText } from "./merge-resolution.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Conflicts this script is allowed to decide on its own. */
const MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  "plugin/.codex-plugin/mcp.json",
  "plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.cursor-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
]);

const git = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" });

const conflicted = git(["diff", "--name-only", "--diff-filter=U"])
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (conflicted.length === 0) {
  console.log("No conflicts to resolve.");
  process.exit(0);
}

const OURS_FILE = ".claude-plugin/marketplace.json";
const hunkCounts = new Map();
const handled = [];
const remaining = [];

for (const file of conflicted) {
  if (!MANIFEST_FILES.has(file)) {
    remaining.push(file);
    continue;
  }

  const path = join(repoRoot, file);
  const original = readFileSync(path, "utf-8");
  let src;
  try {
    src = resolveManifestText(file, original);
  } catch (err) {
    remaining.push(`${file}  (${err.message})`);
    continue;
  }

  writeFileSync(path, src);
  git(["add", file]);
  handled.push(file);
  hunkCounts.set(file, countHunks(original));
}

for (const file of handled) {
  console.log(`  resolved  ${file}  (${hunkCounts.get(file)} hunk(s))`);
  if (file === OURS_FILE && hunkCounts.get(file) > 0) {
    console.log(
      `  WARNING   OUR side was kept for ${hunkCounts.get(file)} hunk(s) in ${file}; review them.`,
    );
  }
}

// Re-stamp the fork version onto whatever base upstream just moved to.
const base = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
).version.replace(/-pb\.\d+$/, "");
console.log(`\nRe-stamping fork version on upstream base ${base}:`);
execFileSync(
  "node",
  [join(repoRoot, "scripts", "fork-version.mjs"), base, "1"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
for (const file of handled) git(["add", file]);

if (remaining.length > 0) {
  console.log(`\n${remaining.length} conflict(s) need you:`);
  for (const file of remaining) console.log(`  ${file}`);
  console.log(
    "\nSource files need a decision each (MAINTAINING.md lists what the fork changes); manifests listed with an error were left untouched and unstaged.",
  );
} else {
  console.log(
    "\nAll conflicts were manifest boilerplate. Nothing left by hand.",
  );
}

console.log(
  "\nThen: npm run check:manifest && npm test && npm run build, and commit the merge.",
);
