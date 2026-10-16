/**
 * On-disk fallback config for clients whose plugin installer does not prompt
 * for `userConfig` (e.g. the GUI app today). The `cognigy-plugin` setup CLI
 * (src/setup.ts) writes this file; `loadConfig()` reads it only when the
 * matching environment variable is absent, so the terminal/keychain path is
 * never overridden.
 *
 * Keys mirror the environment variable names on purpose: the file is just a
 * persisted set of "env vars" the engine would otherwise receive.
 *
 * Every writer goes through updateConfigFile(): lock, read, merge, atomic
 * write, then restrict permissions. Nothing here ever puts file contents
 * (which may hold API keys) into an error or log line.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { ProfileConfigError } from "./profiles/errors.js";
import {
  acquireLock,
  atomicWrite,
  backupRotating,
  ioError,
  restrictToOwner,
  type RestrictResult,
  type WriteOptions,
} from "./configFileIo.js";

export { restrictToOwner } from "./configFileIo.js";
export type {
  CommandRunner,
  LockOptions,
  PermissionOptions,
  RestrictResult,
  WriteOptions,
} from "./configFileIo.js";

export const USER_CONFIG_DIR = join(homedir(), ".cognigy-plugin");
export const USER_CONFIG_FILE = join(USER_CONFIG_DIR, "config.json");

export type UserConfigFile = Record<string, string>;

/** Parsed top-level JSON object of the config file; keys are not prototype-bound. */
export type RawConfig = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parses config text, tolerating a leading UTF-8 BOM. Throws on bad JSON. */
export function parseConfigText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Keys that are never copied out of a file: they could poison prototypes. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Assigns an own data property (safe even for odd key names). */
export function setOwn(target: RawConfig, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Copies safe own entries into a prototype-less object. */
export function toSafeObject(src: Record<string, unknown>): RawConfig {
  const out: RawConfig = Object.create(null) as RawConfig;
  for (const [k, v] of Object.entries(src)) {
    if (!RESERVED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export type RawRead =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "error"; err: unknown }
  | { state: "ok"; data: RawConfig };

/** Only ENOENT is "missing"; other read failures are errors, not corruption. */
function readRaw(path: string): RawRead {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "error", err };
  }
  try {
    const parsed = parseConfigText(text);
    return isPlainObject(parsed)
      ? { state: "ok", data: toSafeObject(parsed) }
      : { state: "corrupt" };
  } catch {
    return { state: "corrupt" };
  }
}

export interface ReadOptions {
  /** Fail closed: anything but a missing file or a valid JSON object throws. */
  strict?: boolean;
}

/** Like readRaw, but unreadable or malformed files throw a fixed-text error. */
export function readStrict(path: string): RawRead {
  const raw = readRaw(path);
  const file = basename(path);
  if (raw.state === "error") {
    const code = (raw.err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new ProfileConfigError(`Cannot read ${file} (${code}).`);
  }
  if (raw.state === "corrupt") {
    throw new ProfileConfigError(`${file} is not a valid JSON object.`);
  }
  return raw;
}

/**
 * Read the fallback config file. Returns `{}` when the file is absent or
 * unreadable/malformed, so a bad file must never throw during server boot
 * (callers treat a missing value the same as an unset env var).
 */
export function readUserConfigFile(
  path: string = USER_CONFIG_FILE,
  options: ReadOptions = {},
): UserConfigFile {
  return legacyFromRaw(readConfigRaw(path, options));
}

/**
 * Reads and parses the file once. Callers that need several sections derive
 * them all from this one result so they never mix two versions of the file.
 */
export function readConfigRaw(
  path: string = USER_CONFIG_FILE,
  options: ReadOptions = {},
): RawRead {
  return options.strict ? readStrict(path) : readRaw(path);
}

/** The legacy flat string fields of a parsed file; anything unusable is empty. */
export function legacyFromRaw(raw: RawRead): UserConfigFile {
  const out: UserConfigFile = {};
  if (raw.state !== "ok") return out;
  for (const [k, v] of Object.entries(raw.data)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Context handed to updateConfigFile mutators. */
export interface UpdateContext {
  /** Keep a verbatim copy of the current file in a `.bak` slot before writing. */
  backup: () => void;
}

/**
 * Locked read-merge-atomic-write for the config file. `mutate` edits the
 * parsed object in place and returns `false` to skip writing. A non-object or
 * unparseable file is backed up (rotating `config.json.bak[.N]`) before being
 * replaced; any other read failure throws and changes nothing. Returns
 * whether the file was written.
 */
export function updateConfigFile(
  file: string,
  mutate: (data: RawConfig, ctx: UpdateContext) => boolean | void,
  options: WriteOptions = {},
): boolean {
  const dir = dirname(file);
  const warnings: string[] = [];
  const note = (r: RestrictResult) => {
    if (!r.ok && r.warning) warnings.push(r.warning);
  };
  if (!existsSync(dir)) {
    // Nothing to lock yet: a mutation that is a no-op on an empty config
    // must not create the directory.
    const probe = toSafeObject({});
    if (mutate(probe, { backup: () => undefined }) === false) return false;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw ioError(`prepare ${basename(dir)}`, err);
  }
  const release = acquireLock(`${file}.lock`, options.lock);
  try {
    const existing = readRaw(file);
    if (existing.state === "error") {
      throw ioError(`read ${basename(file)}`, existing.err);
    }
    const data: RawConfig =
      existing.state === "ok" ? existing.data : toSafeObject({});
    let needsBackup = existing.state === "corrupt";
    const ctx: UpdateContext = {
      backup: () => {
        needsBackup = existing.state !== "missing";
      },
    };
    if (mutate(data, ctx) === false) return false;
    // The directory is owner-only before any secret-bearing file exists.
    note(restrictToOwner(dir, "dir", options));
    if (needsBackup) note(backupRotating(file, options));
    atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`, options);
    note(restrictToOwner(file, "file", options));
  } finally {
    release();
  }
  if (warnings.length > 0) {
    process.stderr.write(
      `[cognigy-plugin] WARNING: could not restrict config permissions to the current user (${warnings.join("; ")})\n`,
    );
  }
  return true;
}

/**
 * Merge `values` into the fallback config file (other keys, including saved
 * profiles, are preserved) with owner-only permissions. Returns the file path.
 */
export function writeUserConfigFile(
  values: UserConfigFile,
  dir: string = USER_CONFIG_DIR,
  options: WriteOptions = {},
): string {
  const file = join(dir, "config.json");
  updateConfigFile(
    file,
    (data) => {
      // Flat string keys are replaced wholesale; every other key (and the
      // defaultProfile selector) is kept unless `values` sets it explicitly.
      const kept = Object.entries(data).filter(
        ([k, v]) =>
          (typeof v !== "string" || k === "defaultProfile") &&
          !Object.prototype.hasOwnProperty.call(values, k),
      );
      for (const k of Object.keys(data)) delete data[k];
      for (const [k, v] of Object.entries(values)) {
        if (!RESERVED_KEYS.has(k)) setOwn(data, k, v);
      }
      for (const [k, v] of kept) setOwn(data, k, v);
    },
    options,
  );
  return file;
}
