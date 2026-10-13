import { inspect } from "util";
/**
 * Named environment profiles. Sources, in precedence order are decided in
 * loadProfiles(); nothing here touches the network.
 */
import { readUserConfigFile } from "../userConfigFile.js";
import {
  deriveEndpointBaseUrl,
  deriveStaticFilesBaseUrl,
  deriveWebchatBaseUrl,
  normalizeApiBaseUrl,
} from "../hosts.js";
import { usableEnv } from "../placeholders.js";
import { resolveDefinitions, type Definition } from "./precedence.js";
import {
  readUserProfilesFile,
  type ProfileProblem,
  type ProfilesFile,
} from "./profilesFile.js";

export type ProfileSource =
  | "legacy-env"
  | "legacy-file"
  | "env-profile"
  | "file-profile";

export interface Profile {
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  endpointBaseUrl: string;
  webchatBaseUrl: string;
  staticFilesBaseUrl: string;
  versionHint?: string;
  source: ProfileSource;
}

export interface ProfileSet {
  profiles: Profile[];
  defaultName: string | undefined;
  /** Profiles that were configured but unusable; reasons never hold secrets. */
  problems: ProfileProblem[];
}

export class ProfileConfigError extends Error {
  override name = "ProfileConfigError";
}

export interface LoadProfilesOptions {
  env?: NodeJS.ProcessEnv;
  legacyFile?: Record<string, string>;
  fileProfiles?: ProfilesFile;
}

const ENV_PROFILE_RE =
  /^COGNIGY_PROFILE_(.+)_(API_BASE_URL|API_KEY|ENDPOINT_BASE_URL|WEBCHAT_BASE_URL|STATIC_FILES_BASE_URL|PLATFORM_VERSION)$/i;

export interface RawFields {
  apiBaseUrl?: string;
  apiKey?: string;
  endpointBaseUrl?: string;
  webchatBaseUrl?: string;
  staticFilesBaseUrl?: string;
  versionHint?: string;
}

const ENV_FIELD: Record<string, keyof RawFields> = {
  API_BASE_URL: "apiBaseUrl",
  API_KEY: "apiKey",
  ENDPOINT_BASE_URL: "endpointBaseUrl",
  WEBCHAT_BASE_URL: "webchatBaseUrl",
  STATIC_FILES_BASE_URL: "staticFilesBaseUrl",
  PLATFORM_VERSION: "versionHint",
};

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Lowercase, underscores to hyphens: the canonical profile name. */
export const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/_/g, "-");

export const isValidProfileName = (name: string): boolean => NAME_RE.test(name);

function assertUrl(field: string, value: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(value).protocol;
  } catch {
    // fall through
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ProfileConfigError(`${field} is not a valid http(s) URL.`);
  }
}

/** Keeps the key readable as `.apiKey` but out of JSON, logs and inspect. */
function protectKey(profile: Profile): Profile {
  const hidden = (value: unknown) => ({
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const { apiKey, ...visible } = profile;
  Object.defineProperty(profile, "apiKey", hidden(apiKey));
  Object.defineProperty(
    profile,
    "toJSON",
    hidden(() => ({ ...visible })),
  );
  Object.defineProperty(
    profile,
    inspect.custom,
    hidden(() => inspect({ ...visible, apiKey: "[REDACTED]" })),
  );
  return profile;
}

/** Throws ProfileConfigError (never quoting secret values) for an unusable profile. */
export function validateProfileFields(name: string, raw: RawFields): void {
  if (!NAME_RE.test(name)) {
    throw new ProfileConfigError(
      `Invalid profile name "${name}": use lowercase letters, digits and hyphens, starting with a letter or digit.`,
    );
  }
  for (const [field, value] of [
    ["API_BASE_URL", raw.apiBaseUrl],
    ["API_KEY", raw.apiKey],
  ] as const) {
    if (!value) {
      throw new ProfileConfigError(`Profile "${name}" is missing ${field}.`);
    }
  }
  const urls = [
    ["apiBaseUrl", raw.apiBaseUrl as string],
    ["endpointBaseUrl", raw.endpointBaseUrl],
    ["webchatBaseUrl", raw.webchatBaseUrl],
    ["staticFilesBaseUrl", raw.staticFilesBaseUrl],
  ] as const;
  for (const [field, value] of urls) {
    if (!value) continue;
    try {
      assertUrl(field, value);
    } catch {
      throw new ProfileConfigError(
        `Profile "${name}": ${field} is not a valid http(s) URL.`,
      );
    }
  }
}

function build(name: string, raw: RawFields, source: ProfileSource): Profile {
  validateProfileFields(name, raw);
  const apiBaseUrl = normalizeApiBaseUrl(raw.apiBaseUrl as string);
  return protectKey({
    name,
    apiBaseUrl,
    apiKey: raw.apiKey as string,
    endpointBaseUrl: raw.endpointBaseUrl || deriveEndpointBaseUrl(apiBaseUrl),
    webchatBaseUrl: raw.webchatBaseUrl || deriveWebchatBaseUrl(apiBaseUrl),
    staticFilesBaseUrl:
      raw.staticFilesBaseUrl || deriveStaticFilesBaseUrl(apiBaseUrl),
    ...(raw.versionHint ? { versionHint: raw.versionHint } : {}),
    source,
  });
}

/** A usable (non-empty, non-placeholder) value, trimmed. */
function val(value: string | undefined): string | undefined {
  return usableEnv(value)?.trim() || undefined;
}

function legacyFields(
  env: NodeJS.ProcessEnv,
  file: Record<string, string>,
): { raw: RawFields; source: ProfileSource } | undefined {
  const pick = (key: string) => val(env[key]) || val(file[key]);
  const envUrl = val(env.COGNIGY_API_BASE_URL);
  const envKey = val(env.COGNIGY_API_KEY);
  const raw: RawFields = {
    apiBaseUrl: pick("COGNIGY_API_BASE_URL"),
    apiKey: pick("COGNIGY_API_KEY"),
    endpointBaseUrl: pick("COGNIGY_ENDPOINT_BASE_URL"),
    webchatBaseUrl: pick("COGNIGY_WEBCHAT_BASE_URL"),
    staticFilesBaseUrl: pick("COGNIGY_STATIC_FILES_BASE_URL"),
  };
  if (!raw.apiBaseUrl || !raw.apiKey) return undefined;
  return { raw, source: envUrl && envKey ? "legacy-env" : "legacy-file" };
}

/** Env profile settings by normalised name, plus the spellings that produced them. */
function envProfiles(env: NodeJS.ProcessEnv): {
  found: Map<string, RawFields>;
  problems: ProfileProblem[];
} {
  const found = new Map<string, RawFields>();
  const spellings = new Map<string, Set<string>>();
  const problems: ProfileProblem[] = [];
  const definitions = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const m = ENV_PROFILE_RE.exec(key);
    const v = val(value);
    if (!m || !v) continue;
    const name = normalizeName(m[1]);
    const field = ENV_FIELD[m[2].toUpperCase()];
    const fields = found.get(name) ?? {};
    const settingKey = `${m[1].toUpperCase()}|${field}`;
    if (definitions.has(settingKey)) {
      problems.push({
        name,
        reason: `${m[2].toUpperCase()} is defined more than once (variable names differ only by case).`,
      });
    }
    definitions.add(settingKey);
    fields[field] = v;
    found.set(name, fields);
    const seen = spellings.get(name) ?? new Set<string>();
    seen.add(m[1].toUpperCase());
    spellings.set(name, seen);
  }
  for (const [name, seen] of spellings) {
    if (seen.size > 1) {
      problems.push({
        name,
        reason: `Names collide after normalisation: ${[...seen]
          .map((s) => `"${s}"`)
          .join(" and ")} both become "${name}".`,
      });
    }
  }
  return { found, problems };
}

function fileFields(raw: ProfilesFile["profiles"][string]): RawFields {
  const out: RawFields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && typeof value !== "string") {
      throw new ProfileConfigError(`${key} must be a string.`);
    }
  }
  for (const key of Object.keys(ENV_FIELD).map((k) => ENV_FIELD[k])) {
    out[key] = val(raw[key]);
  }
  return out;
}
/** Pure: reads only the supplied options (all default to empty). */
export function loadProfiles(options: LoadProfilesOptions = {}): ProfileSet {
  const env = options.env ?? {};
  const legacyFile = options.legacyFile ?? {};
  const fileProfiles = options.fileProfiles ?? { profiles: {}, problems: [] };
  // Every definition is recorded with its source; precedence decides later.
  const definitions: Definition[] = (fileProfiles.problems ?? []).map((p) => ({
    ...p,
    source: "file-profile" as const,
  }));

  const attempt = (
    name: string,
    raw: () => RawFields,
    source: ProfileSource,
  ) => {
    try {
      definitions.push({ name, source, profile: build(name, raw(), source) });
    } catch (err) {
      definitions.push({ name, source, reason: (err as Error).message });
    }
  };

  const legacy = legacyFields(env, legacyFile);
  if (legacy) attempt("default", () => legacy.raw, legacy.source);

  for (const [name, raw] of Object.entries(fileProfiles.profiles)) {
    attempt(name, () => fileFields(raw), "file-profile");
  }

  const fromEnv = envProfiles(env);
  for (const p of fromEnv.problems) {
    definitions.push({ ...p, source: "env-profile" });
  }
  const collided = new Set(fromEnv.problems.map((p) => p.name));
  for (const [name, raw] of fromEnv.found) {
    if (!collided.has(name)) attempt(name, () => raw, "env-profile");
  }

  const { profiles: byName, problems } = resolveDefinitions(definitions);
  const byNameAsc = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const profiles = [...byName.values()].sort(byNameAsc);
  problems.sort(byNameAsc);
  const wantedRaw =
    val(env.COGNIGY_PROFILE) || val(fileProfiles.defaultProfile);
  const wanted = wantedRaw ? normalizeName(wantedRaw) : undefined;
  if (wanted && !byName.has(wanted)) {
    const broken = problems.find((p) => p.name === wanted);
    const available = profiles.map((p) => p.name).join(", ") || "none";
    throw new ProfileConfigError(
      `Default profile "${wanted}" ${
        broken ? `is unusable (${broken.reason})` : "is not configured"
      }. Available: ${available}.`,
    );
  }
  const defaultName =
    wanted ??
    (byName.has("default")
      ? "default"
      : profiles.length === 1
        ? profiles[0].name
        : undefined);
  return { profiles, defaultName, problems };
}

export interface SystemDeps {
  env?: NodeJS.ProcessEnv;
  readLegacyFile?: () => Record<string, string>;
  readProfilesFile?: () => ProfilesFile;
}

/** Loads profiles from process.env and the user's config file on disk. */
export function loadProfilesFromSystem(deps: SystemDeps = {}): ProfileSet {
  return loadProfiles({
    env: deps.env ?? process.env,
    legacyFile: (deps.readLegacyFile ?? readUserConfigFile)(),
    fileProfiles: (deps.readProfilesFile ?? readUserProfilesFile)(),
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}

export function describeProfile(p: Profile): {
  name: string;
  apiHost: string;
  endpointHost: string;
  source: ProfileSource;
  versionHint?: string;
} {
  return {
    name: p.name,
    apiHost: hostOf(p.apiBaseUrl),
    endpointHost: hostOf(p.endpointBaseUrl),
    source: p.source,
    ...(p.versionHint ? { versionHint: p.versionHint } : {}),
  };
}

export function getProfile(set: ProfileSet, name?: string): Profile {
  const available = set.profiles.map((p) => p.name).join(", ");
  const wanted = name === undefined ? set.defaultName : normalizeName(name);
  const broken = set.problems.find((p) => p.name === wanted);
  if (broken) {
    throw new ProfileConfigError(
      `Environment "${wanted}" is unusable: ${broken.reason}`,
    );
  }
  if (set.profiles.length === 0) {
    throw new ProfileConfigError("No environment is configured.");
  }
  if (!wanted) {
    throw new ProfileConfigError(
      `Pass an environment name; available environments: ${available}.`,
    );
  }
  const found = set.profiles.find((p) => p.name === wanted);
  if (!found) {
    throw new ProfileConfigError(
      `Unknown environment "${wanted}"; available environments: ${available}.`,
    );
  }
  return found;
}
