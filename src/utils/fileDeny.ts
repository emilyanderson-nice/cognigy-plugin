/**
 * Path policy for utils/fileAccess: what may never be read or written even
 * inside the root, which Windows names are unsafe, and which roots are refused.
 * Pure helpers (plus os.homedir and realpath for the root check).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DENIED_SEGMENTS = new Set([
  ".git",
  ".claude",
  ".cognigy-plugin",
  ".vscode",
  ".husky",
  ".github",
  ".ssh",
  ".gnupg",
  ".aws",
  "node_modules",
]);

const DENIED_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "package.json",
  "package-lock.json",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".bash_profile",
]);

const DENIED_BASENAME_PATTERNS = [
  /^\.env\..*$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^credentials/,
];

/** Whether any segment (relative to the root) names something off limits. */
export function isDeniedPath(relSegments: string[]): boolean {
  const lower = relSegments.map((s) => s.toLowerCase());
  if (lower.some((s) => DENIED_SEGMENTS.has(s))) return true;
  const base = lower[lower.length - 1] ?? "";
  return (
    DENIED_BASENAMES.has(base) ||
    DENIED_BASENAME_PATTERNS.some((re) => re.test(base))
  );
}

const WINDOWS_RESERVED =
  /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)(\..*)?$/i;

/** Segments Windows treats as devices or silently rewrites. */
export function isUnsafeWindowsSegment(segment: string): boolean {
  return (
    WINDOWS_RESERVED.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  );
}

/** True when `target` is strictly inside `root` (only a real `..` segment escapes). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}

const sameDir = (a: string, b: string): boolean =>
  path.relative(a, b) === "" && path.relative(b, a) === "";

/**
 * A root that is a filesystem root, the home directory, or an ancestor of the
 * plugin's credential directory would expose far more than a project.
 */
export function isDangerousRoot(realRoot: string): boolean {
  if (sameDir(path.parse(realRoot).root, realRoot)) return true;
  // HOME / USERPROFILE are checked too: they are what os.homedir() reads on
  // each platform, and either one may be the effective home of this process.
  const homes = new Set(
    [os.homedir(), process.env.HOME, process.env.USERPROFILE].filter(
      (h): h is string => !!h && path.isAbsolute(h),
    ),
  );
  for (const configured of homes) {
    let home = configured;
    try {
      home = fs.realpathSync(configured);
    } catch {
      // an unreadable home directory is compared as given
    }
    if (sameDir(home, realRoot)) return true;
    if (isInside(realRoot, path.join(home, ".cognigy-plugin"))) return true;
  }
  return false;
}
