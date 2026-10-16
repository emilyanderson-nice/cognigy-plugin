/**
 * Named profiles stored in the user config file (~/.cognigy-plugin/config.json)
 * under "profiles" / "defaultProfile", next to the legacy flat string map.
 */
import {
  isPlainObject,
  RESERVED_KEYS,
  readUserConfigRaw,
  type RawRead,
  type ReadOptions,
  USER_CONFIG_FILE,
} from "../userConfigFile.js";

export interface RawFileProfile {
  apiBaseUrl: string;
  apiKey: string;
  endpointBaseUrl?: string;
  webchatBaseUrl?: string;
  staticFilesBaseUrl?: string;
  versionHint?: string;
}

export interface ProfileProblem {
  name: string;
  reason: string;
}

export interface ProfilesFile {
  defaultProfile?: string;
  profiles: Record<string, RawFileProfile>;
  /** Entries that were present but unusable; never contains secret values. */
  problems: ProfileProblem[];
}

const OPTIONAL_KEYS = [
  "endpointBaseUrl",
  "webchatBaseUrl",
  "staticFilesBaseUrl",
  "versionHint",
] as const;

const RESERVED_NAMES = RESERVED_KEYS;

/** A usable profile, or the (secret-free) reason the entry is malformed. */
function toRawProfile(v: unknown): RawFileProfile | string {
  if (!isPlainObject(v)) return "entry is not an object";
  if (typeof v.apiBaseUrl !== "string") return "apiBaseUrl must be a string";
  if (typeof v.apiKey !== "string") return "apiKey must be a string";
  const out: RawFileProfile = { apiBaseUrl: v.apiBaseUrl, apiKey: v.apiKey };
  for (const key of OPTIONAL_KEYS) {
    const value = v[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${key} must be a string`;
    out[key] = value;
  }
  return out;
}

/** Reads the profiles section; absent or unreadable files yield no profiles. */
function collect(parsed: Record<string, unknown>, result: ProfilesFile): void {
  if (typeof parsed.defaultProfile === "string") {
    result.defaultProfile = parsed.defaultProfile;
  }
  if (isPlainObject(parsed.profiles)) {
    for (const [name, raw] of Object.entries(parsed.profiles)) {
      if (RESERVED_NAMES.has(name)) continue;
      const profile = toRawProfile(raw);
      if (typeof profile === "string") {
        result.problems.push({ name, reason: profile });
      } else {
        result.profiles[name] = profile;
      }
    }
  }
}

/**
 * Reads the profiles section. By default an absent or unreadable file yields
 * no profiles; with `strict`, only an absent file does and anything else throws.
 */
export function readUserProfilesFile(
  path: string = USER_CONFIG_FILE,
  options: ReadOptions = {},
): ProfilesFile {
  return profilesOf(readUserConfigRaw(path, options));
}

/** The profiles section of an already-read file. */
export function profilesOf(raw: RawRead): ProfilesFile {
  const result: ProfilesFile = { profiles: {}, problems: [] };
  if (raw.state === "ok") collect(raw.data, result);
  return result;
}
