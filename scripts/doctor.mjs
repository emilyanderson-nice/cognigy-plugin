#!/usr/bin/env node
/**
 * Check that the plugin INSTALLED in Claude Code is actually this fork.
 *
 * check-plugin-manifest.mjs guards what the repo commits. It cannot see the
 * client, and the client is where the fork silently stopped running:
 *
 *   Claude Code caches a plugin at <marketplace>/<plugin>/<version>. The fork
 *   shared both the marketplace name "cognigy-plugin" and, after merging
 *   upstream, the version number 1.19.0. A stale upstream entry left in that
 *   cache was served under the fork's install — right marketplace, right
 *   version, plugin enabled, no error, and the STOCK engine running with none
 *   of the fork's behaviour.
 *
 * The marketplace is now named apart from upstream so that exact collision
 * cannot recur, but a manual `/plugin marketplace add Cognigy/cognigy-plugin`
 * or a half-finished dev switch can still leave the wrong thing installed.
 * This reports what is really there.
 *
 * Run: npm run doctor
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORK_MARKETPLACE_NAME as FORK_MARKETPLACE,
  FORK_REPO,
  LEGACY_FORK_REPO,
  UPSTREAM_REPO,
  enginePin,
} from "./fork-identity.mjs";
import {
  BOOT_TIMEOUT_MS,
  bootExitMessage,
  bootSpawnPlan,
  bootTimeoutMessage,
  killPlan,
} from "./doctor-boot.mjs";

// Manifests are pinned to the release tag, so compare and boot that pin.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_VERSION = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
).version;
const ENGINE_SPEC = enginePin(ENGINE_VERSION);

const claudeDir = join(homedir(), ".claude");
const pluginsDir = join(claudeDir, "plugins");

const problems = [];
const notes = [];
const ok = [];

/** Sensitive userConfig lives in the OS keychain, not in settings.json. */
function readPluginSecrets() {
  if (process.platform !== "darwin") return {};
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return (
      JSON.parse(raw)?.pluginSecrets?.[`cognigy@${FORK_MARKETPLACE}`] ?? {}
    );
  } catch {
    return {};
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

// --- 1. Registered marketplaces ------------------------------------------
const marketplaces =
  readJson(join(pluginsDir, "known_marketplaces.json")) ?? {};
const entries = Object.entries(marketplaces);

const forkEntry = entries.find(
  ([, v]) => (v?.source?.repo ?? "").toLowerCase() === FORK_REPO.toLowerCase(),
);
const upstreamEntry = entries.find(
  ([, v]) =>
    (v?.source?.repo ?? "").toLowerCase() === UPSTREAM_REPO.toLowerCase(),
);

if (!forkEntry) {
  problems.push(
    `The fork's marketplace (${FORK_REPO}) is not registered. Run: claude plugin marketplace add ${FORK_REPO}`,
  );
} else {
  const [name] = forkEntry;
  ok.push(`marketplace "${name}" -> ${FORK_REPO}`);
  if (name !== FORK_MARKETPLACE) {
    problems.push(
      `The fork is registered as "${name}" but should be "${FORK_MARKETPLACE}". An old registration under upstream's name can collide in the plugin cache. Remove and re-add it.`,
    );
  }
}

const legacyEntry = entries.find(
  ([, v]) =>
    (v?.source?.repo ?? "").toLowerCase() === LEGACY_FORK_REPO.toLowerCase(),
);
if (legacyEntry) {
  problems.push(
    `The previous fork's marketplace (${LEGACY_FORK_REPO}) is registered as "${legacyEntry[0]}". It ships a different engine; having it alongside this fork is how the wrong plugin gets installed. Remove it: claude plugin marketplace remove ${legacyEntry[0]}`,
  );
}

if (upstreamEntry) {
  problems.push(
    `Upstream's marketplace (${UPSTREAM_REPO}) is registered as "${upstreamEntry[0]}". It ships the stock engine; having it alongside the fork is how the wrong plugin gets installed. Remove it: claude plugin marketplace remove ${upstreamEntry[0]}`,
  );
}

// --- 2. Enabled plugin ----------------------------------------------------
const settings = readJson(join(claudeDir, "settings.json")) ?? {};
const enabled = Object.entries(settings.enabledPlugins ?? {})
  .filter(([, on]) => on)
  .map(([id]) => id);

const forkPluginId = `cognigy@${FORK_MARKETPLACE}`;
if (!enabled.includes(forkPluginId)) {
  problems.push(
    `"${forkPluginId}" is not enabled (enabled: ${enabled.join(", ") || "none"}). Run: claude plugin install ${forkPluginId}`,
  );
} else {
  ok.push(`plugin "${forkPluginId}" enabled`);
}

// --- 3. Every cached manifest must point at the fork's engine -------------
const cacheRoot = join(pluginsDir, "cache");
let checkedManifests = 0;
if (existsSync(cacheRoot)) {
  for (const marketplace of readdirSync(cacheRoot)) {
    const pluginRoot = join(cacheRoot, marketplace);
    for (const plugin of safeReaddir(pluginRoot)) {
      for (const version of safeReaddir(join(pluginRoot, plugin))) {
        const manifestPath = join(
          pluginRoot,
          plugin,
          version,
          ".claude-plugin",
          "plugin.json",
        );
        const manifest = readJson(manifestPath);
        if (!manifest) continue;
        checkedManifests += 1;

        const args = manifest.mcpServers?.platform?.args ?? [];
        const spec = args.find((a) => typeof a === "string" && a.includes(":"));
        const isForkMarketplace = marketplace === FORK_MARKETPLACE;
        const usesNpmEngine = args.some(
          (a) => typeof a === "string" && a.includes("@cognigy/plugin-engine@"),
        );

        if (isForkMarketplace && usesNpmEngine) {
          problems.push(
            `Cached ${marketplace}/${plugin}/${version} pins the npm engine (${spec}) instead of ${ENGINE_SPEC}. This is the stale-cache failure: purge it with rm -rf ${cacheRoot}/${marketplace} then re-add the marketplace.`,
          );
        } else if (isForkMarketplace) {
          ok.push(`cached ${marketplace}/${plugin}/${version} -> ${spec}`);
        } else if (usesNpmEngine) {
          notes.push(
            `Leftover cache from another marketplace: ${marketplace}/${plugin}/${version} (stock engine). Harmless while unused; delete it to be sure.`,
          );
        }
      }
    }
  }
}
if (checkedManifests === 0) {
  notes.push("No cached plugin manifests found — nothing is installed yet.");
}

// --- 4. Required userConfig, as the CLIENT sees it ------------------------
//
// The manifest's env block expands ${user_config.*}, and both options are
// declared required. Claude Code will not start a server whose required
// userConfig is unset — so the engine can be perfectly healthy while the
// client never launches it. The boot check below cannot see this, because it
// supplies the environment itself; only the stored config tells you whether
// the CLIENT can start the server.
const cachedManifestPath = (() => {
  const base = join(cacheRoot, FORK_MARKETPLACE, "cognigy");
  for (const version of safeReaddir(base)) {
    const candidate = join(base, version, ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
})();

const cachedManifest = cachedManifestPath ? readJson(cachedManifestPath) : null;
const requiredOptions = Object.entries(cachedManifest?.userConfig ?? {})
  .filter(([, spec]) => spec?.required)
  .map(([key]) => key);

if (requiredOptions.length > 0) {
  const stored = settings.pluginConfigs?.[forkPluginId]?.options ?? {};
  const secrets = readPluginSecrets();
  const missing = requiredOptions.filter(
    (key) => stored[key] === undefined && secrets[key] === undefined,
  );
  if (missing.length > 0) {
    problems.push(
      `Required plugin config not set: ${missing.join(", ")}. Claude Code will not start the server without it, however healthy the engine is. Fix with /plugin configure ${forkPluginId}.`,
    );
  } else {
    ok.push(`required plugin config set (${requiredOptions.join(", ")})`);
  }
}

// --- 5. Credentials -------------------------------------------------------
const credsFile = join(homedir(), ".cognigy-plugin", "config.json");
const creds = readJson(credsFile);
const hasEnv = process.env.COGNIGY_API_KEY && process.env.COGNIGY_API_BASE_URL;
const pluginConfigured =
  settings.pluginConfigs?.[forkPluginId]?.options?.cognigy_api_base_url;

if (!hasEnv && !creds?.COGNIGY_API_KEY && !pluginConfigured) {
  problems.push(
    `No credentials found. Set them with /plugin configure ${forkPluginId}, or write ${credsFile} with COGNIGY_API_BASE_URL and COGNIGY_API_KEY.`,
  );
} else if (creds?.COGNIGY_API_KEY) {
  ok.push(`credentials via ${credsFile} (${creds.COGNIGY_API_BASE_URL})`);
} else {
  ok.push("credentials via plugin config or environment");
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// --- 6. Does the engine actually start? ----------------------------------
//
// Every check above can pass while the server does not run at all: a nested
// npx in an install-time script once deadlocked the build, so the bin was
// never written and the MCP server silently never appeared. Booting it here
// is the only check that would have caught that — and it warms the npx cache
// as a side effect, which matters because every push moves the git HEAD the
// spec resolves to and a cold boot takes about 2 minutes versus about 13 s warm.
//
// Skip with --no-boot when offline or in a hurry.
async function bootCheck() {
  const started = Date.now();
  return new Promise((done) => {
    // The plan detaches on POSIX so the whole process group can be killed: npx
    // spawns the real server as a child, and killing only the npx wrapper
    // leaves that child running. A doctor meant to be run routinely must not
    // leak an MCP server on every invocation.
    const plan = bootSpawnPlan(ENGINE_VERSION, process.platform);
    const proc = spawn(plan.command, plan.args, {
      ...plan.options,
      env: {
        ...process.env,
        COGNIGY_API_BASE_URL:
          creds?.COGNIGY_API_BASE_URL ?? "https://api-trial-us.cognigy.ai",
        COGNIGY_API_KEY: creds?.COGNIGY_API_KEY ?? "doctor-probe",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Writing to a closed pipe raises an unhandled 'error' event on stdin and
    // would crash doctor; failures are already reported by exit/error below.
    proc.stdin.on("error", () => {});
    let buf = "";
    // Only the end of stderr matters (npm prints its reason last); cap it.
    let tail = "";
    let finished = false;
    const finish = (result) => {
      // Idempotent: our own kill below makes the child emit "exit", and the
      // timer may race a result; only the first outcome counts.
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Kill the whole tree so the spawned server dies with the wrapper
      // rather than outliving it.
      const kill = killPlan(process.platform, proc.pid);
      try {
        if (kill.command) {
          const res = spawnSync(kill.command, kill.args, {
            stdio: "ignore",
            windowsHide: true,
          });
          if (res.error || res.status !== 0) proc.kill("SIGKILL");
        } else {
          process.kill(kill.pid, kill.signal);
        }
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      done(result);
    };
    const timer = setTimeout(
      () => finish({ failed: bootTimeoutMessage() }),
      BOOT_TIMEOUT_MS,
    );

    proc.stderr.on("data", (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });
    proc.on("exit", (code, signal) =>
      finish({ failed: bootExitMessage(code, signal, tail.trim()) }),
    );

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          proc.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }) + "\n",
          );
          proc.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
              "\n",
          );
        }
        if (msg.id === 2) {
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          finish({
            seconds: ((Date.now() - started) / 1000).toFixed(1),
            toolCount: names.length,
            hasForkTool: names.includes("manage_flows"),
          });
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    proc.on("error", (err) => finish({ failed: err.message }));
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "doctor", version: "1" },
        },
      }) + "\n",
    );
  });
}

if (!process.argv.includes("--no-boot")) {
  const boot = await bootCheck();
  if (boot.failed) {
    problems.push(`The engine failed to start: ${boot.failed}`);
  } else if (!boot.hasForkTool) {
    problems.push(
      `The engine started (${boot.toolCount} tools in ${boot.seconds}s) but does not expose manage_flows — that is the stock engine, not this fork.`,
    );
  } else {
    ok.push(
      `engine boots in ${boot.seconds}s, ${boot.toolCount} tools, fork-only manage_flows present`,
    );
  }
} else {
  notes.push("Boot check skipped (--no-boot).");
}

// --- Report ---------------------------------------------------------------
for (const line of ok) console.log(`  ✓ ${line}`);
for (const line of notes) console.log(`  · ${line}`);
for (const line of problems) console.error(`  ✗ ${line}`);

if (problems.length > 0) {
  console.error(
    `\n${problems.length} problem${problems.length === 1 ? "" : "s"}. The plugin may be running the stock engine rather than this fork.`,
  );
  process.exit(1);
}
console.log("\n✓ Claude Code is running this fork.");
