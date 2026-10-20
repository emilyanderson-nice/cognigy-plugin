#!/usr/bin/env node
/**
 * Stamp the fork's version across package.json and every plugin manifest.
 *
 * The fork's version is always `<upstream version>-pb.<n>`:
 *
 *   upstream 1.19.0  ->  1.19.0-pb.1
 *
 * The base number says which upstream release this fork is built on, which is
 * the thing you actually want to know during a merge. The `-pb.N` suffix keeps
 * the fork's version distinct from upstream's, so a client can never confuse
 * the two — the plugin cache is keyed partly on version, and a shared
 * marketplace name plus a shared version once caused the stock engine to be
 * served under this fork's install.
 *
 * Usage:
 *   node scripts/fork-version.mjs                 # bump the suffix: -pb.1 -> -pb.2
 *   node scripts/fork-version.mjs 1.20.0          # rebase onto upstream 1.20.0, reset to -pb.1
 *   node scripts/fork-version.mjs 1.20.0 3        # explicit base and suffix
 *
 * After merging upstream, run it with upstream's new version — that is the one
 * step the merge needs beyond resolving conflicts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replaceEnginePin } from "./fork-identity.mjs";

export const FORK_SUFFIX = "pb";
const FORK_VERSION_RE = /^(\d+\.\d+\.\d+)-pb\.(\d+)$/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Manifests that carry a version and/or an engine pin, mirroring
 * sync-plugin-version.mjs. Pin-only files have no version field.
 */
const FILES = [
  "package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  "plugin/.codex-plugin/mcp.json",
  "plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.cursor-plugin/plugin.json",
];

/** Split a version into its upstream base and fork suffix number. */
export function parseForkVersion(version) {
  const match = FORK_VERSION_RE.exec(version ?? "");
  if (match) return { base: match[1], forkNumber: Number(match[2]) };
  const plain = /^(\d+\.\d+\.\d+)/.exec(version ?? "");
  return { base: plain ? plain[1] : null, forkNumber: 0 };
}

/**
 * Rewrite the two version fields package-lock.json carries for the project
 * itself: the root `version` and `packages[""].version`. A scan of the text
 * (string- and depth-aware) finds exactly those two values, so no other
 * entry, URL, line ending or indentation is touched.
 */
export function stampLockfileVersion(text, version) {
  const spans = [];
  const frames = [];
  const top = () => frames[frames.length - 1];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      frames.push({ name: frames.length ? top().key : null, key: null });
    } else if (ch === "}" || ch === "]") {
      frames.pop();
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const value = text.slice(i + 1, j);
      const isKey = /^\s*:/.test(text.slice(j + 1, j + 64));
      if (isKey) {
        top().key = value;
      } else if (top() && top().key === "version") {
        const path = frames.slice(1).map((f) => f.name);
        const root = path.length === 0;
        const pkgRoot =
          path.length === 2 && path[0] === "packages" && path[1] === "";
        if (root || pkgRoot) spans.push([i + 1, j]);
      }
      i = j;
    }
  }
  let out = text;
  for (const [start, end] of spans.reverse()) {
    out = out.slice(0, start) + version + out.slice(end);
  }
  return out;
}

function main() {
  const pkgPath = join(repoRoot, "package.json");
  const current = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  const parsed = parseForkVersion(current);

  const baseArg = process.argv[2];
  const numberArg = process.argv[3];

  const base = baseArg ?? parsed.base;
  if (!base || !/^\d+\.\d+\.\d+$/.test(base)) {
    console.error(
      `Could not determine a base version from "${current}". Pass one: node scripts/fork-version.mjs 1.20.0`,
    );
    process.exit(1);
  }

  // A new base restarts the count; without one, bump the existing suffix.
  const forkNumber = numberArg
    ? Number(numberArg)
    : baseArg && baseArg !== parsed.base
      ? 1
      : parsed.forkNumber + 1;

  const next = `${base}-${FORK_SUFFIX}.${forkNumber}`;

  for (const rel of FILES) {
    const path = join(repoRoot, rel);
    const src = readFileSync(path, "utf-8");
    // Replaced in place rather than via a JSON round-trip so each file keeps
    // its existing formatting and stays Prettier-clean.
    const out = replaceEnginePin(
      src.replace(/("version":\s*")[^"]*(")/, `$1${next}$2`),
      next,
    );
    writeFileSync(path, out);

    const check = JSON.parse(out).version;
    if (check !== undefined && check !== next) {
      console.error(`FAILED to set ${rel} to ${next} (still ${check})`);
      process.exit(1);
    }
    console.log(`  ${rel} -> ${next}`);
  }

  const lockPath = join(repoRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const lockSrc = readFileSync(lockPath, "utf-8");
    writeFileSync(lockPath, stampLockfileVersion(lockSrc, next));
    console.log(`  package-lock.json -> ${next}`);
  }

  console.log(`\nFork version: ${current} -> ${next} (upstream base ${base})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
