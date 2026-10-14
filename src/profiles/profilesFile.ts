/**
 * Named profiles stored in the user config file (~/.cognigy-plugin/config.json)
 * under "profiles" / "defaultProfile", next to the legacy flat string map.
 */
import { readFileSync } from "fs";
import {
  isPlainObject,
  parseConfigText,
  RESERVED_KEYS,
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
export function readUserProfilesFile(
  path: string = USER_CONFIG_FILE,
): ProfilesFile {
  const result: ProfilesFile = { profiles: {}, problems: [] };
  try {
    const parsed = parseConfigText(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) return result;
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
  } catch {
    // Missing or malformed: behave as if no profiles were configured.
  }
  return result;
}
