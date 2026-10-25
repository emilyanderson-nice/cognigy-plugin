/**
 * Safe local file access for tool arguments that name a file.
 *
 * Everything is confined to one root: the real path of COGNIGY_FILE_ROOT (when
 * it names an existing absolute directory) or else the process working
 * directory. A root that is a filesystem root, the home directory or an
 * ancestor of ~/.cognigy-plugin is refused (bad_root). Inside the root, a deny
 * list (utils/fileDeny.ts) blocks git/IDE/CI config, credentials and key
 * files, package manifests and shell startup files, for reads and writes.
 * Symlinks and Windows reparse points are refused on every existing path
 * component, sizes are capped, content must be valid UTF-8, and the round trip
 * is byte-exact for valid text (a lone surrogate in an API string becomes
 * U+FFFD when written). Writes are atomic: a temp file in the same directory is
 * fsynced and renamed over the target (overwrite) or hard-linked in (create),
 * so a hard link to an outside file is never written through and a failure
 * leaves the old target untouched.
 *
 * Functions THROW FileAccessError with a fixed message; messages never carry
 * file contents or absolute paths.
 *
 * Known limit: the checks and the open are separate steps, so a narrow race
 * against a concurrent local actor that swaps a directory for a link remains.
 * It is narrowed by O_NOFOLLOW and a post-open realpath/fstat recheck, but
 * O_NOFOLLOW is not available on Windows.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isDangerousRoot,
  isDeniedPath,
  isInside,
  isUnsafeWindowsSegment,
} from "./fileDeny.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class FileAccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FileAccessError";
  }
}

const fail = (code: string, message: string): never => {
  throw new FileAccessError(message, code);
};

const OUTSIDE = "File path must stay inside the allowed root.";
const NOT_FOUND = "File not found inside the allowed root.";
const NOT_A_FILE = "The path is not a regular file.";
const EXISTS = "The file already exists; set overwrite to replace it.";

/** The directory file arguments are confined to, resolved at call time. */
export function fileRoot(): string {
  const configured = process.env.COGNIGY_FILE_ROOT;
  if (configured && path.isAbsolute(configured)) {
    try {
      if (fs.statSync(configured).isDirectory()) {
        return fs.realpathSync(configured);
      }
    } catch {
      // fall through to the working directory
    }
  }
  return fs.realpathSync(process.cwd());
}

function canonicalRoot(root: string): string {
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return fail("bad_root", "The file root is not an accessible directory.");
  }
  if (isDangerousRoot(real)) {
    return fail(
      "bad_root",
      "The file root must be a project directory, not a drive root or the home directory.",
    );
  }
  return real;
}

/** Resolve an absolute input whose spelling differs from the real root path. */
function realisedAbsolute(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
}

/**
 * Validate `input` and return its absolute path, which is guaranteed to lie
 * strictly inside `root`. Does not touch the filesystem for relative inputs.
 */
export function resolveInRoot(
  input: unknown,
  root: string = fileRoot(),
  options: ResolveOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (typeof input !== "string" || input.trim() === "") {
    return fail("invalid_path", "File path must be a non-empty string.");
  }
  if (input.includes("\0")) {
    return fail("invalid_path", "File path contains an invalid character.");
  }
  if (/^[\\/]{2}/.test(input)) {
    return fail("invalid_path", "Network and device paths are not allowed.");
  }
  // A backslash separates segments for the deny check on every platform, so
  // `.git\config` is refused on POSIX too (where it is otherwise one file name).
  // Absolute inputs are checked below, relative to the root, to avoid judging
  // the directories above it.
  const rawSegments = input.split(/[\\/]+/).filter((s) => s !== "");
  if (!path.isAbsolute(input) && isDeniedPath(rawSegments)) {
    return fail("denied_path", "Access to this path is not allowed.");
  }
  const realRoot = canonicalRoot(root);
  const windows = platform === "win32";
  if (windows && /^[A-Za-z]:(?![\\/])/.test(input)) {
    return fail("invalid_path", "Drive-relative paths are not allowed.");
  }
  const segments = input.split(/[\\/]+/).filter((s) => s !== "");
  if (
    windows &&
    segments.some(
      (s, i) => s.includes(":") && !(i === 0 && /^[A-Za-z]:$/.test(s)),
    )
  ) {
    return fail("invalid_path", "File path contains an invalid character.");
  }

  let abs: string;
  if (path.isAbsolute(input)) {
    if (segments.includes("..")) return fail("outside_root", OUTSIDE);
    abs = path.resolve(input);
    if (!isInside(realRoot, abs)) abs = realisedAbsolute(abs);
  } else {
    let depth = 0;
    for (const seg of segments) {
      if (seg === "..") depth -= 1;
      else if (seg !== ".") depth += 1;
      if (depth < 0) return fail("outside_root", OUTSIDE);
    }
    abs = path.resolve(realRoot, input);
  }
  if (!isInside(realRoot, abs)) return fail("outside_root", OUTSIDE);

  const rel = path
    .relative(realRoot, abs)
    .split(path.sep)
    .flatMap((s) => s.split("\\"));
  if (isDeniedPath(rel)) {
    return fail("denied_path", "Access to this path is not allowed.");
  }
  const named = path.isAbsolute(input)
    ? rel
    : [...rel, ...segments.filter((s) => s !== "." && s !== "..")];
  if (windows && named.some(isUnsafeWindowsSegment)) {
    return fail("invalid_path", "File path contains a name Windows rejects.");
  }
  return abs;
}

/** lstat every existing component below root; refuse links. Returns the final stat or null if absent. */
function checkComponents(root: string, abs: string): fs.Stats | null {
  const parts = path.relative(root, abs).split(path.sep);
  let current = root;
  let last: fs.Stats | null = null;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      last = fs.lstatSync(current);
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      return fail("unreadable", "The file could not be accessed.");
    }
    if (last.isSymbolicLink()) {
      return fail("symlink", "Symbolic links and junctions are not allowed.");
    }
    if (i < parts.length - 1 && !last.isDirectory()) {
      return fail("not_found", NOT_FOUND);
    }
  }
  return last;
}

/** Post-open recheck: the real location of `p` must still be inside root. */
async function assertStillInside(root: string, p: string): Promise<void> {
  let real: string;
  try {
    real = await fs.promises.realpath(p);
  } catch {
    return fail("outside_root", OUTSIDE);
  }
  if (!isInside(root, real)) fail("outside_root", OUTSIDE);
}

export interface ReadOptions {
  maxBytes?: number;
}

export async function readTextFile(
  input: unknown,
  root: string = fileRoot(),
  options: ReadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const realRoot = canonicalRoot(root);
  const abs = resolveInRoot(input, realRoot);
  const stat = checkComponents(realRoot, abs);
  if (!stat) return fail("not_found", NOT_FOUND);
  if (!stat.isFile()) return fail("not_a_file", NOT_A_FILE);
  const tooBig = () =>
    fail("too_large", `The file is larger than the ${maxBytes} byte limit.`);
  if (stat.size > maxBytes) tooBig();

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      abs,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return fail("unreadable", "The file could not be read.");
  }
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return fail("not_a_file", NOT_A_FILE);
    if (opened.size > maxBytes) tooBig();
    await assertStillInside(realRoot, abs);
    bytes = await handle.readFile();
  } catch (err) {
    if (err instanceof FileAccessError) throw err;
    return fail("unreadable", "The file could not be read.");
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.length > maxBytes) tooBig();
  try {
    // ignoreBOM: true KEEPS a leading BOM in the output (as U+FEFF); it does not strip it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail("not_utf8", "The file is not valid UTF-8 text.");
  }
}

export interface WriteOptions {
  overwrite?: boolean;
  maxBytes?: number;
}

export interface WriteResult {
  path: string;
  bytes: number;
  sha256: string;
}

export const sha256Hex = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

const remove = (p: string): void => {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
};

const CREATE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);

/** Exclusively create `file` (mode 0o600) holding `data`, fsynced; removes it again on failure. */
function createDurable(file: string, data: Buffer): void {
  const fd = fs.openSync(file, CREATE_FLAGS, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    remove(file);
    throw err;
  }
  fs.closeSync(fd);
}

/** Create `target` from the finished temp file without ever replacing an existing one. */
function linkIntoPlace(temp: string, target: string, data: Buffer): void {
  try {
    fs.linkSync(temp, target);
    return;
  } catch (err: any) {
    if (err?.code === "EEXIST") return fail("exists", EXISTS);
    // hard links unsupported here: fall back to an exclusive create
  }
  try {
    createDurable(target, data);
  } catch (err: any) {
    if (err?.code === "EEXIST") return fail("exists", EXISTS);
    throw err;
  }
}

export async function writeTextFile(
  input: unknown,
  text: string,
  root: string = fileRoot(),
  options: WriteOptions = {},
): Promise<WriteResult> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const realRoot = canonicalRoot(root);
  const abs = resolveInRoot(input, realRoot);
  const data = Buffer.from(text, "utf8");
  if (data.length > maxBytes) {
    return fail(
      "too_large",
      `The content is larger than the ${maxBytes} byte limit.`,
    );
  }

  const parent = path.dirname(abs);
  if (parent !== realRoot) {
    const parentStat = checkComponents(realRoot, parent);
    if (!parentStat?.isDirectory()) {
      return fail(
        "no_parent",
        "The parent directory does not exist inside the allowed root.",
      );
    }
  }
  const existing = checkComponents(realRoot, abs);
  if (existing) {
    if (!existing.isFile()) return fail("not_a_file", NOT_A_FILE);
    if (!options.overwrite) return fail("exists", EXISTS);
  }

  const temp = path.join(
    parent,
    `.${path.basename(abs)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    createDurable(temp, data);
  } catch {
    return fail("write_failed", "The file could not be written.");
  }
  try {
    await assertStillInside(realRoot, temp);
    if (options.overwrite) fs.renameSync(temp, abs);
    else linkIntoPlace(temp, abs, data);
  } catch (err) {
    remove(temp);
    if (err instanceof FileAccessError) throw err;
    return fail("write_failed", "The file could not be written.");
  }
  if (!options.overwrite) remove(temp);

  return {
    path: path.relative(realRoot, abs).split(path.sep).join("/"),
    bytes: data.length,
    sha256: sha256Hex(data),
  };
}
