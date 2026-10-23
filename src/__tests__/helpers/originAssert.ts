import { afterEach, beforeEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fail, show } from "./specAssert.js";
import type { ProfileSet } from "../../profiles/profiles.js";

/** A pasted shell command: not a URL, and it embeds a URL-like secret. */
export const BAD_VALUE = 'curl -H "x" https://example.test/secret-token';
export const GOOD_URL = "https://api-good.cognigy.ai";
export const FAKE_KEY = "fake-key-ORIGIN-distinct-7";

export const FILE_ORIGIN = "~/.cognigy-plugin/config.json";
export const LEGACY_ENV_API_ORIGIN =
  "the environment variable COGNIGY_API_BASE_URL (in Claude Code this is the plugin setting cognigy_api_base_url)";

/** The exact message the loaders must record when an origin is known. */
export function withOrigin(
  name: string,
  field: string,
  origin: string,
): string {
  return `Profile "${name}": ${field} is not a valid http(s) URL (value from ${origin}).`;
}

/**
 * Asserts the set has no usable profile `name`, and that its recorded problem
 * contains `expected` verbatim, is one line and leaks neither the value nor a URL.
 */
export function expectOriginProblem(
  set: ProfileSet,
  name: string,
  expected: string,
  what: string,
): void {
  const why =
    "B3: an invalid URL message names which setting the bad value came from, without quoting it";
  const guidance =
    'Record `Profile "<name>": <field> is not a valid http(s) URL (value from <origin>).` using the origin of THAT field only; never include the value';
  const problem = set.problems.find((p) => p.name === name);
  if (!problem)
    fail(
      what,
      why,
      `a problem recorded for "${name}"`,
      `problems: ${show(set.problems)}`,
      guidance,
    );
  const reason = problem.reason;
  const checks: Array<[boolean, string]> = [
    [reason.includes(expected), `contains exactly: ${expected}`],
    [!/[\r\n]/.test(reason), "is a single line"],
    [!reason.includes("://"), 'does not contain "://"'],
    [!reason.includes("secret-token"), "does not contain the offending value"],
    [!reason.includes(FAKE_KEY), "does not contain key material"],
    [
      !set.profiles.some((p) => p.name === name),
      `profile "${name}" is not usable`,
    ],
  ];
  const bad = checks.filter(([good]) => !good).map(([, text]) => text);
  if (bad.length > 0)
    fail(
      what,
      why,
      checks.map(([, t]) => t).join("; "),
      `reason ${JSON.stringify(reason)} violates: ${bad.join("; ")}`,
      guidance,
    );
}

/** Origin text for a legacy variable supplied through the environment. */
export const envOrigin = (variable: string): string =>
  variable === "COGNIGY_API_BASE_URL"
    ? LEGACY_ENV_API_ORIGIN
    : `the environment variable ${variable}`;

/**
 * Points HOME and USERPROFILE at a fresh temp dir for each test, so a real
 * ~/.cognigy-plugin/config.json can never be read. Returns a getter for the dir.
 * Registers its own beforeEach/afterEach.
 */
export function useTempHome(prefix: string): () => string {
  let home: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), prefix));
    saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}
