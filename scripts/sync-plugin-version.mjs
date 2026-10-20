// Keeps every tracked plugin manifest in lockstep with the release version.
// For each file it rewrites the top-level `version` field (when present).
//
// This fork installs the engine from GitHub rather than npm, pinned to the
// release tag v<version>; the pin is rewritten together with the version. The
// check below asserts the npm pin has not returned via an
// upstream merge, which would silently swap the fork's engine for the stock
// one. Invoked by
// semantic-release (.releaserc exec prepareCmd) with the computed next
// version; the bumped manifests are committed via the git assets.
//
// Fields are replaced in place (not a JSON round-trip) so each file's
// existing formatting is preserved and stays Prettier-clean.

import { readFileSync, writeFileSync } from "node:fs";
import { replaceEnginePin } from "./fork-identity.mjs";

const version = process.argv[2];
if (!version) {
  console.error("usage: sync-plugin-version.mjs <version>");
  process.exit(1);
}

// Every committed manifest that carries the plugin version and/or an engine
// pin.
const FILES = [
  "plugin/.claude-plugin/plugin.json", // version + engine pin
  "plugin/.codex-plugin/plugin.json", // version
  "plugin/.codex-plugin/mcp.json", // engine pin
  "plugin/plugin.json", // version (Agent Plugins spec manifest)
  "plugin/mcp.json", // engine pin (Agent Plugins spec MCP config)
  "plugin/.cursor-plugin/plugin.json", // version + engine pin (Cursor)
];

for (const file of FILES) {
  const src = readFileSync(file, "utf8");
  const next = replaceEnginePin(
    src.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`),
    version,
  );
  writeFileSync(file, next);

  const parsed = JSON.parse(next);
  if (parsed.version !== undefined && parsed.version !== version) {
    console.error(
      `[release] FAILED to set ${file} version to ${version} (still ${parsed.version}); the version field may have moved.`,
    );
    process.exit(1);
  }

  // An npm engine pin here means an upstream merge reintroduced Cognigy's
  // published engine, which would run instead of this fork's source.
  if (next.includes("@cognigy/plugin-engine@")) {
    console.error(
      `[release] ${file} still pins the npm engine (@cognigy/plugin-engine@...). This fork installs from GitHub; re-apply the github: spec after the merge.`,
    );
    process.exit(1);
  }
  console.error(`[release] synced ${file} -> ${version}`);
}
