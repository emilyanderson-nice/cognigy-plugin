#!/usr/bin/env node
/**
 * Create (and optionally publish) the git tag this fork's engine pin points at.
 *
 * The plugin manifests pin the engine as `github:<fork repo>#v<version>`, so
 * that pin only resolves once the tag `v<version>` exists on origin. This
 * script makes the tag, and it is deliberately safe: it changes nothing unless
 * told to, and it never publishes without an explicit flag.
 *
 * Usage:
 *   node scripts/release-tag.mjs                    # dry run: print the plan, change nothing
 *   node scripts/release-tag.mjs --create           # annotated tag at HEAD, local only
 *   node scripts/release-tag.mjs --push             # push an existing local tag (only that tag)
 *   node scripts/release-tag.mjs --create --push    # both
 *
 * It refuses (non-zero exit) when the tree is dirty, the tag already exists,
 * `npm run check:manifest` (scripts/check-plugin-manifest.mjs) fails, HEAD is
 * not on an origin branch (origin is fetched first), or the version is not a
 * fork version. It also refuses when origin cannot be read, when origin (fetch
 * or push URL) is not this fork's repository, and (for --push) when the local
 * tag does not point at HEAD. The repo root is derived from this file's
 * location, so the cwd does not matter. Only `refs/tags/<tag>` is ever pushed — never
 * `--tags` and never a branch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FORK_REPO, FORK_VERSION_RE, enginePin } from "./fork-identity.mjs";

// The repo root is the parent of this script's folder, never the caller's cwd,
// so running from a subdirectory behaves exactly like running from the root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Decide whether the tag can be made. Pure: all repository facts come in as
 * `state` = { version, dirty, localTags, remoteTags, pinMatches, headOnRemote }.
 */
export function planTag(state) {
  const {
    version,
    dirty,
    localTags,
    remoteTags,
    pinMatches,
    headOnRemote,
    remoteReadable,
    tagAtHead,
    originIsFork,
  } = state;
  const tag = `v${version}`;
  const problems = [];

  if (!FORK_VERSION_RE.test(version ?? "")) {
    problems.push(
      `Version "${version}" is not a fork version (expected <x.y.z>-pb.<n>), so no tag is made.`,
    );
  }
  if (dirty) {
    problems.push(
      "The working tree has uncommitted changes; commit or stash them first.",
    );
  }
  if ((localTags ?? []).includes(tag)) {
    problems.push(`Tag ${tag} already exists locally.`);
  }
  if ((remoteTags ?? []).includes(tag)) {
    problems.push(`Tag ${tag} already exists on origin.`);
  }
  if (!pinMatches) {
    problems.push(
      `The manifest pin or version fields do not pass \`npm run check:manifest\` for ${enginePin(version)}; run the version script, then retry.`,
    );
  }
  if (originIsFork === false) {
    problems.push(
      "The origin remote is not this fork's repository, so the tag would be published to the wrong place.",
    );
  }
  if (!headOnRemote) {
    problems.push(
      "HEAD is not pushed to any remote branch; push the commit before tagging.",
    );
  }
  if (remoteReadable === false) {
    problems.push(
      "Could not read tags from origin; check the network and your access, then retry.",
    );
  }
  if (tagAtHead === false) {
    problems.push(
      `Tag ${tag} does not point at HEAD, so it would publish a different commit than the one checked.`,
    );
  }

  return { tag, ok: problems.length === 0, problems };
}

function git(args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function readJson(rel) {
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// The manifest checker is the single source of truth for pin and version agreement.
function pinMatchesAll() {
  const r = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "check-plugin-manifest.mjs")],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  return r.status === 0;
}

const normaliseRemote = (url) =>
  url
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

function originIsForkRepo() {
  const fetchUrl = git(["remote", "get-url", "origin"]);
  const pushUrl = git(["remote", "get-url", "--push", "origin"]);
  if (fetchUrl.status !== 0 || pushUrl.status !== 0) return false;
  const repo = FORK_REPO.toLowerCase();
  return [fetchUrl.stdout, pushUrl.stdout].every((u) => {
    const n = normaliseRemote(u);
    return n.endsWith(`/${repo}`) || n.endsWith(`:${repo}`);
  });
}

function headOnOriginBranch() {
  // Refresh first so a stale remote-tracking ref cannot make an unpushed
  // commit look pushed. A failed fetch means origin is unreadable.
  // --no-tags: fetching must never import origin's tags as local ones.
  const fetched = git(["fetch", "--prune", "--quiet", "--no-tags", "origin"]);
  if (fetched.status !== 0)
    return { remoteReadable: false, headOnRemote: false };
  return {
    remoteReadable: true,
    // Only origin/* counts: a commit that exists only on another remote is not
    // pushed to the place the tag will be published.
    headOnRemote:
      lines(
        git(["branch", "-r", "--list", "origin/*", "--contains", "HEAD"])
          .stdout,
      ).length > 0,
  };
}

function gatherState() {
  const version = readJson("package.json")?.version;
  const remote = git(["ls-remote", "--tags", "origin"]);
  const remoteTags = lines(remote.stdout).map((l) =>
    (l.split(/\s+/)[1] ?? "")
      .replace(/^refs\/tags\//, "")
      .replace(/\^\{\}$/, ""),
  );
  const headState = headOnOriginBranch();
  return {
    version,
    dirty: lines(git(["status", "--porcelain"]).stdout).length > 0,
    localTags: lines(git(["tag", "-l"]).stdout),
    remoteTags,
    pinMatches: version ? pinMatchesAll() : false,
    remoteReadable: remote.status === 0 && headState.remoteReadable,
    headOnRemote: headState.headOnRemote,
    originIsFork: originIsForkRepo(),
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const create = flags.has("--create");
  const push = flags.has("--push");

  const state = gatherState();
  const tagName = `v${state.version}`;
  const pushOnlyMode = push && !create;
  let plan;
  if (pushOnlyMode && state.localTags.includes(tagName)) {
    const tagCommit = git(["rev-list", "-n", "1", tagName]).stdout.trim();
    const headCommit = git(["rev-parse", "HEAD"]).stdout.trim();
    plan = planTag({ ...state, tagAtHead: tagCommit === headCommit });
  } else {
    plan = planTag(state);
  }
  const head = git(["rev-parse", "--short", "HEAD"]).stdout.trim();

  // Pushing a tag that already exists locally must not trip the "exists locally" rule.
  const pushOnly = push && !create;
  const problems = pushOnly
    ? plan.problems.filter((p) => !p.includes("already exists locally"))
    : plan.problems;
  if (pushOnly && !state.localTags.includes(plan.tag)) {
    problems.push(
      `Tag ${plan.tag} does not exist locally; create it first with --create.`,
    );
  }
  const ok = problems.length === 0;

  console.log(`Tag:    ${plan.tag}`);
  console.log(`Target: ${head || "(unknown)"} (HEAD)`);
  if (ok) console.log("Status: ready");
  for (const p of problems) console.log(`Problem: ${p}`);

  if (!create && !push) {
    console.log("\nDry run: nothing changed. Use --create and/or --push.");
    process.exit(ok ? 0 : 1);
  }
  if (!ok) fail("\nRefusing to continue: fix the problems above.");

  if (create) {
    const r = git(["tag", "-a", plan.tag, "-m", `Release ${plan.tag}`, "HEAD"]);
    if (r.status !== 0)
      fail(`Could not create tag ${plan.tag}: ${r.stderr.trim()}`);
    console.log(`Created annotated tag ${plan.tag} at ${head}.`);
  }
  if (push) {
    const r = git(["push", "origin", `refs/tags/${plan.tag}`]);
    if (r.status !== 0)
      fail(
        `Could not push tag ${plan.tag}: ${r.stderr.trim()}\nThe local tag ${plan.tag} exists; retry the push alone with \`node scripts/release-tag.mjs --push\`.`,
      );
    console.log(`Pushed ${plan.tag} to origin.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
