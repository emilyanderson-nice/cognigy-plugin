#!/usr/bin/env node
/**
 * Guards the published form of the tracked plugin manifests:
 *   - plugin/.claude-plugin/plugin.json  (Claude Code)
 *   - plugin/.codex-plugin/plugin.json   (Codex)
 *   - plugin/.codex-plugin/mcp.json      (Codex MCP servers)
 *   - plugin/plugin.json                 (Agent Plugins spec 1.0.0 manifest)
 *   - plugin/mcp.json                    (Agent Plugins spec 1.0.0 MCP config)
 *   - plugin/.cursor-plugin/plugin.json  (Cursor marketplace listing)
 *
 * Local dev testing runs the engine from source via a GENERATED manifest
 * (scripts/dev-plugin.mjs → .dev-plugin/, gitignored). The tracked manifests
 * must always keep the published npx form — a committed `node …/dist/index.js`
 * or unpinned engine would ship a broken plugin to every user. Runs in
 * pre-commit and CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORK_MARKETPLACE_NAME,
  FORK_VERSION_RE,
  engineLaunchArgs,
} from "./fork-identity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

// This fork is NOT published to npm — it is installed straight from GitHub,
// so the engine that runs is this repo's source (built by the `prepare` hook)
// rather than Cognigy's published package. Upstream pins an npm alias here
// (cognigy-engine@npm:@cognigy/plugin-engine@<v>); that form must not come
// back on a merge, or the plugin would silently run the stock engine and the
// fork's changes would vanish with no error.
// The pin is the fork's GitHub repo at the release tag for package.json's
// version (see fork-identity.mjs).
// The fork's version is always <upstream base>-esc.<n> (legacy: -pb.<n>). Sharing upstream's
// exact version number is half of what let a client cache serve the stock
// engine under this fork's install; the marketplace name is the other half.
const expectedArgs = engineLaunchArgs(pkg.version);

function checkPlatformServer(platform, errors) {
  if (!platform) {
    errors.push("mcpServers.platform is missing");
    return;
  }
  if (platform.command !== "npx") {
    errors.push(
      `platform.command must be "npx" (got ${JSON.stringify(platform.command)}) — ` +
        "local-dev manifests are generated, never committed (npm run plugin:dev)",
    );
  }
  if (JSON.stringify(platform.args) !== JSON.stringify(expectedArgs)) {
    errors.push(
      `platform.args must be ${JSON.stringify(expectedArgs)} (got ${JSON.stringify(platform.args)})`,
    );
  }
}

function checkVersion(manifest, errors) {
  if (manifest.version !== pkg.version) {
    errors.push(
      `plugin version ${manifest.version} != package version ${pkg.version} — ` +
        "never hand-bump; semantic-release syncs both",
    );
  }
}

function checkClaudeManifest(manifest, errors) {
  checkPlatformServer(manifest.mcpServers?.platform, errors);
  checkVersion(manifest, errors);
}

function checkCodexPluginJson(manifest, errors) {
  checkVersion(manifest, errors);
  if (manifest.skills !== "./skills/") {
    errors.push(
      `skills pointer must be "./skills/" (got ${JSON.stringify(manifest.skills)})`,
    );
  }
  if (typeof manifest.mcpServers !== "string") {
    errors.push(
      `mcpServers must be a path pointer string (got ${JSON.stringify(manifest.mcpServers)})`,
    );
  } else if (!existsSync(join(repoRoot, "plugin", manifest.mcpServers))) {
    errors.push(`mcpServers pointer ${manifest.mcpServers} does not resolve`);
  }
  // The store page renders these; a renamed asset would silently fall back to
  // the generic icon, which is invisible in review.
  for (const field of ["logo", "composerIcon"]) {
    const value = manifest.interface?.[field];
    if (value === undefined) continue;
    if (!existsSync(join(repoRoot, "plugin", value))) {
      errors.push(
        `interface.${field} points at ${value}, which does not exist`,
      );
    }
  }
}

function checkCodexMcpJson(manifest, errors) {
  checkPlatformServer(manifest.mcpServers?.platform, errors);
}

// Agent Plugins spec 1.0.0 (https://agent-plugins.org) — closed schemas, so
// the $schema constants and server `type` variants are load-bearing: a
// conformant client rejects the plugin (or drops the server entry) on any
// deviation. Claude Code and Codex never read these root-level files.
const SPEC_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const SPEC_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function checkSpecPluginJson(manifest, errors) {
  if (manifest.$schema !== SPEC_PLUGIN_SCHEMA) {
    errors.push(
      `$schema must be ${SPEC_PLUGIN_SCHEMA} (got ${JSON.stringify(manifest.$schema)})`,
    );
  }
  if (manifest.name !== "cognigy") {
    errors.push(
      `name must be "cognigy" (got ${JSON.stringify(manifest.name)})`,
    );
  }
  checkVersion(manifest, errors);
}

function checkSpecMcpJson(manifest, errors) {
  if (manifest.$schema !== SPEC_MCP_SCHEMA) {
    errors.push(
      `$schema must be ${SPEC_MCP_SCHEMA} (got ${JSON.stringify(manifest.$schema)})`,
    );
  }
  const platform = manifest.mcpServers?.platform;
  checkPlatformServer(platform, errors);
  if (platform && platform.type !== "stdio") {
    errors.push(
      `platform.type must be "stdio" (got ${JSON.stringify(platform.type)})`,
    );
  }
  // The portable entry must stay credential-less: the spec forbids secrets in
  // `env` and only expands ${PLUGIN_ROOT}/${PLUGIN_DATA}, so the engine reads
  // credentials from ~/.cognigy-plugin/config.json instead.
  if (platform && platform.env !== undefined) {
    errors.push("platform must not carry an env block in the spec mcp.json");
  }
  if (manifest.mcpServers?.docs?.type !== "streamable-http") {
    errors.push(
      `docs.type must be "streamable-http" (got ${JSON.stringify(manifest.mcpServers?.docs?.type)})`,
    );
  }
}

// Cursor loads the plugin fine from the Agent Plugins spec files alone; this
// manifest exists for what the closed spec schema cannot carry — the branded
// marketplace listing (logo/displayName), the agents/ components (outside
// spec v1), and `variables`, Cursor's dashboard-managed user config that
// restores the credentialed setup (${VAR} placeholders in env; the spec
// mcp.json must stay credential-less).
function checkCursorPluginJson(manifest, errors) {
  checkVersion(manifest, errors);
  checkPlatformServer(manifest.mcpServers?.platform, errors);
  const env = manifest.mcpServers?.platform?.env;
  if (
    env?.COGNIGY_API_BASE_URL !== "${COGNIGY_API_BASE_URL}" ||
    env?.COGNIGY_API_KEY !== "${COGNIGY_API_KEY}"
  ) {
    errors.push(
      "platform.env must reference the declared variables as ${COGNIGY_API_BASE_URL} / ${COGNIGY_API_KEY} — " +
        "literal values would commit credentials",
    );
  }
  for (const varName of ["COGNIGY_API_BASE_URL", "COGNIGY_API_KEY"]) {
    if (manifest.variables?.properties?.[varName] === undefined) {
      errors.push(`variables.properties.${varName} is missing`);
    }
  }
  if (manifest.logo && !existsSync(join(repoRoot, "plugin", manifest.logo))) {
    errors.push(`logo points at ${manifest.logo}, which does not exist`);
  }
}

const CHECKS = [
  ["plugin/.claude-plugin/plugin.json", checkClaudeManifest],
  ["plugin/.codex-plugin/plugin.json", checkCodexPluginJson],
  ["plugin/.codex-plugin/mcp.json", checkCodexMcpJson],
  ["plugin/plugin.json", checkSpecPluginJson],
  ["plugin/mcp.json", checkSpecMcpJson],
  ["plugin/.cursor-plugin/plugin.json", checkCursorPluginJson],
  [".claude-plugin/marketplace.json", checkMarketplaceJson],
];

/**
 * The fork's marketplace must NOT be named like upstream's.
 *
 * Claude Code caches a plugin at <marketplace>/<plugin>/<version>. When the
 * fork and upstream shared both the marketplace name "cognigy-plugin" and a
 * version number, the cache key collided: a stale upstream entry was served
 * under the fork's install, silently running the STOCK engine with the right
 * marketplace, the right version and no error anywhere. An upstream merge
 * restoring the shared name would make that possible again.
 */
function checkMarketplaceJson(manifest, errors) {
  if (manifest.name !== FORK_MARKETPLACE_NAME) {
    errors.push(
      `marketplace name must be "${FORK_MARKETPLACE_NAME}" (got ${JSON.stringify(manifest.name)}) — ` +
        "sharing upstream's name lets client plugin caches collide and serve the stock engine",
    );
  }
}

if (!FORK_VERSION_RE.test(pkg.version)) {
  console.error(
    `✗ package.json version "${pkg.version}" is not a fork version (expected <x.y.z>-esc.<n>; -pb.<n> is the legacy form, still accepted).\n` +
      "  An upstream merge takes their number; re-stamp it with: node scripts/fork-version.mjs <upstream version>",
  );
  process.exit(1);
}

let failed = false;

// package-lock.json repeats the version at the root and at packages[""]; a
// stale lockfile makes `npm ci` / installs disagree with package.json.
const lockPath = join(repoRoot, "package-lock.json");
if (existsSync(lockPath)) {
  let lock;
  let lockErrors;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch (err) {
    lockErrors = [
      `${lockPath} is not valid JSON (${err.message}); restore it from git or regenerate it with npm install`,
    ];
  }
  if (lock !== undefined) {
    const lockFields = [
      ["version", lock?.version],
      ['packages[""].version', lock?.packages?.[""]?.version],
    ];
    lockErrors = lockFields
      .filter(([, value]) => value !== pkg.version)
      .map(
        ([field, value]) =>
          `${field} is ${JSON.stringify(value)} but package.json version is ${pkg.version}`,
      );
  }
  if (lockErrors.length > 0) {
    failed = true;
    console.error(`✗ ${lockPath} failed validation:`);
    for (const error of lockErrors) console.error(`  - ${error}`);
    if (lock !== undefined) {
      console.error(
        "  Re-stamp with: node scripts/fork-version.mjs <base> <n> (never hand-edit)",
      );
    }
  }
}

for (const [relPath, check] of CHECKS) {
  const manifestPath = join(repoRoot, relPath);
  const errors = [];
  check(JSON.parse(readFileSync(manifestPath, "utf-8")), errors);
  if (errors.length > 0) {
    failed = true;
    console.error(`✗ ${manifestPath} failed validation:`);
    for (const error of errors) console.error(`  - ${error}`);
  }
}

if (failed) process.exit(1);
console.log("✓ plugin manifests OK (published npx form, version in sync)");
