/**
 * Add, remove and default-select named profiles in the user config file.
 * All writes go through updateConfigFile (merge-preserving, atomic, owner-only),
 * and no error raised here ever quotes a field value, so API keys stay secret.
 */
import {
  isPlainObject,
  RESERVED_KEYS,
  setOwn,
  toSafeObject,
  updateConfigFile,
  USER_CONFIG_FILE,
  type RawConfig,
  type UpdateContext,
  type WriteOptions,
} from "../userConfigFile.js";
import {
  normalizeName,
  ProfileConfigError,
  validateProfileFields,
} from "./profiles.js";
import type { RawFileProfile } from "./profilesFile.js";

export interface StoreOptions extends WriteOptions {
  path?: string;
}

const STRING_FIELDS = [
  "apiBaseUrl",
  "apiKey",
  "endpointBaseUrl",
  "webchatBaseUrl",
  "staticFilesBaseUrl",
  "versionHint",
] as const;

/** Only the known string fields, trimmed; apiBaseUrl loses one trailing slash. */
function cleanProfile(name: string, profile: RawFileProfile): RawFileProfile {
  const out: Record<string, string> = {};
  for (const key of STRING_FIELDS) {
    const value: unknown = profile[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ProfileConfigError(
        `Profile "${name}": ${key} must be a string.`,
      );
    }
    let trimmed = value.trim();
    if (key === "apiBaseUrl") trimmed = trimmed.replace(/\/$/, "");
    if (trimmed !== "" || key === "apiBaseUrl" || key === "apiKey") {
      out[key] = trimmed;
    }
  }
  return out as unknown as RawFileProfile;
}

/**
 * The writable profiles map: created when absent. A present but non-object
 * value is dropped (the original file is backed up first).
 */
function profilesSection(data: RawConfig, ctx: UpdateContext): RawConfig {
  const existing = data.profiles;
  if (existing !== undefined && !isPlainObject(existing)) ctx.backup();
  const section = toSafeObject(isPlainObject(existing) ? existing : {});
  setOwn(data, "profiles", section);
  return section;
}

function existingNames(data: RawConfig): string[] {
  return isPlainObject(data.profiles)
    ? Object.keys(data.profiles).filter((k) => !RESERVED_KEYS.has(k))
    : [];
}

/** The stored spelling for `name`: exact match first, then the canonical form. */
function resolveStoredName(names: string[], name: string): string | undefined {
  if (names.includes(name)) return name;
  const canonical = normalizeName(name);
  return names.includes(canonical) ? canonical : undefined;
}

/** Saves (adds or replaces) one profile; returns whether it was newly created. */
export function upsertProfile(
  name: string,
  profile: RawFileProfile,
  options: StoreOptions = {},
): { created: boolean } {
  if (RESERVED_KEYS.has(name)) {
    throw new ProfileConfigError(
      `Invalid profile name "${name}": the name is reserved.`,
    );
  }
  const clean = cleanProfile(name, profile);
  validateProfileFields(name, clean);
  let created = false;
  updateConfigFile(
    options.path ?? USER_CONFIG_FILE,
    (data, ctx) => {
      const profiles = profilesSection(data, ctx);
      created = !Object.prototype.hasOwnProperty.call(profiles, name);
      setOwn(profiles, name, clean);
    },
    options,
  );
  return { created };
}

/** Deletes a profile; returns whether it existed. */
export function removeProfile(
  name: string,
  options: StoreOptions = {},
): boolean {
  let removed = false;
  updateConfigFile(
    options.path ?? USER_CONFIG_FILE,
    (data, ctx) => {
      const target = resolveStoredName(existingNames(data), name);
      if (target === undefined) return false;
      const profiles = profilesSection(data, ctx);
      delete profiles[target];
      const canonical = normalizeName(target);
      const def = data.defaultProfile;
      if (def === target || (def === canonical && !(canonical in profiles))) {
        delete data.defaultProfile;
      }
      removed = true;
    },
    options,
  );
  return removed;
}

/** Sets (or, with undefined, clears) the default profile name. */
export function setDefaultProfile(
  name: string | undefined,
  options: StoreOptions = {},
): void {
  updateConfigFile(
    options.path ?? USER_CONFIG_FILE,
    (data) => {
      if (name === undefined) {
        if (!("defaultProfile" in data)) return false;
        delete data.defaultProfile;
        return;
      }
      const names = existingNames(data);
      const stored = resolveStoredName(names, name);
      if (stored === undefined) {
        throw new ProfileConfigError(
          `Unknown profile "${normalizeName(name)}"; existing profiles: ${names.join(", ") || "none"}.`,
        );
      }
      setOwn(data, "defaultProfile", stored);
    },
    options,
  );
}
