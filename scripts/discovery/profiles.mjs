/**
 * Shared by the read-only discovery probes: where credentials come from. Values are returned to the
 * caller and never printed or written here.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENV_FILE =
  [".env.local", "env.local"].map((n) => join(ROOT, n)).find(existsSync) ||
  join(ROOT, ".env.local");

export function fail(msg) {
  console.error(`probe: ${msg}`);
  process.exit(2);
}

/** KEY=value lines of the env file ({} when it does not exist); comment lines are skipped. */
export function readEnvVars() {
  const vars = {};
  if (!existsSync(ENV_FILE)) return vars;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#"))
      vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

function loadEnvFileProfile(name) {
  const vars = readEnvVars();
  const prefix = `COGNIGY_PROFILE_${name.toUpperCase().replace(/-/g, "_")}_`;
  const baseUrl = vars[`${prefix}API_BASE_URL`];
  const apiKey = vars[`${prefix}API_KEY`];
  if (!baseUrl || !apiKey) return null;
  return {
    name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    declaredVersion: vars[`${prefix}PLATFORM_VERSION`],
  };
}

// A profile saved with cognigy-setup lives in the user's config file, not in
// env.local. The engine's own loader reads it, so the key is never parsed or
// printed here. Requires `npm run build`.
async function loadSavedProfile(name) {
  try {
    const mod = await import(
      pathToFileURL(join(ROOT, "dist", "profiles", "profiles.js")).href
    );
    const found = mod
      .loadProfilesFromSystem()
      .profiles.find((p) => p.name === name);
    if (!found) return null;
    return {
      name,
      baseUrl: found.apiBaseUrl.replace(/\/+$/, ""),
      apiKey: found.apiKey,
      declaredVersion: found.versionHint,
    };
  } catch {
    return null;
  }
}

export async function loadProfile(name) {
  const profile = loadEnvFileProfile(name) ?? (await loadSavedProfile(name));
  if (!profile)
    fail(
      `profile "${name}" not found: set COGNIGY_PROFILE_<NAME>_API_BASE_URL and _API_KEY in env.local, or save it with cognigy-setup (and run npm run build)`,
    );
  return profile;
}
