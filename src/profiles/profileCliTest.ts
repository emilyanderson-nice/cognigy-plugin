import { describeProfile, getProfile, type Profile } from "./profiles.js";
import { createReleaseDetector } from "./release.js";
import { ArgError, parseArgs } from "./profileCliArgs.js";
import type { ProfileCliDeps } from "./profileCliTypes.js";

const PROBE_PATH = "/v2.0/projects?limit=1";

export interface CheckResult {
  ok: boolean;
  detail: string;
}

/** A numeric HTTP status from a thrown value, else undefined. Never the message. */
function statusOf(thrown: unknown): number | undefined {
  const e = thrown as
    | { status?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  const status = e?.response?.status ?? e?.status;
  return typeof status === "number" ? status : undefined;
}

const DEFAULT_DEADLINE_MS = 20000;

const REASONS: ReadonlyArray<[RegExp, string]> = [
  [/^(ENOTFOUND|EAI_AGAIN)$/, "DNS lookup failed"],
  [/^(ETIMEDOUT|ECONNABORTED|ESOCKETTIMEDOUT)$/, "timed out"],
  [/^ECONNREFUSED$/, "connection refused"],
  [/^ECONNRESET$/, "connection reset"],
  [/^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED)/, "TLS error"],
];

/** A short fixed reason for a thrown value; never its message. */
function reasonOf(thrown: unknown): string {
  const status = statusOf(thrown);
  if (status !== undefined) return `HTTP ${status}`;
  const code = (thrown as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    for (const [pattern, text] of REASONS) {
      if (pattern.test(code)) return text;
    }
  }
  return "request failed";
}

async function probeAndDetect(
  profile: Profile,
  deps: ProfileCliDeps,
): Promise<CheckResult> {
  const getter = deps.createGetter(profile);
  try {
    await getter.get(PROBE_PATH);
  } catch (thrown) {
    return { ok: false, detail: reasonOf(thrown) };
  }
  const info = await createReleaseDetector(getter).detect();
  return {
    ok: true,
    detail: info.release ? `release ${info.release.raw}` : "release unknown",
  };
}

/**
 * One live check under an overall deadline (probe and release detection
 * together); a late resolution is ignored. The detail never contains a thrown
 * message or the key.
 */
export async function checkProfile(
  profile: Profile,
  deps: ProfileCliDeps,
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, detail: "timed out" }),
      deps.checkTimeoutMs ?? DEFAULT_DEADLINE_MS,
    );
  });
  const attempt = probeAndDetect(profile, deps).catch(
    (thrown): CheckResult => ({ ok: false, detail: reasonOf(thrown) }),
  );
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function formatCheckLine(profile: Profile, result: CheckResult): string {
  const { name, apiHost } = describeProfile(profile);
  return `${result.ok ? "ok" : "FAIL"}  ${name}  ${apiHost}  ${result.detail}\n`;
}

/** Distinct unusable names with their first reason, in name order. */
function unusableByName(
  problems: ReadonlyArray<{ name: string; reason: string }>,
): Array<[string, string]> {
  const first = new Map<string, string>();
  for (const p of problems) if (!first.has(p.name)) first.set(p.name, p.reason);
  return [...first].sort(([a], [b]) => a.localeCompare(b));
}

export async function runTest(
  tokens: string[],
  deps: ProfileCliDeps,
): Promise<number> {
  let args;
  try {
    args = parseArgs("test", tokens, { bool: ["--all"] });
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    deps.err(`${e.message}\n`);
    return 1;
  }
  const set = deps.loadProfiles();
  const all = args.flags.has("--all");
  let targets: Profile[];
  if (all) {
    targets = set.profiles.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (targets.length === 0 && set.problems.length === 0) {
      deps.err("No environments are configured.\n");
      return 1;
    }
  } else if (args.positionals.length === 0 && !set.defaultName) {
    const names = set.profiles.map((p) => p.name).join(", ") || "none";
    deps.err(
      `No default environment is set: pass an environment name or --all; available environments: ${names}.\n`,
    );
    return 1;
  } else {
    try {
      targets = [getProfile(set, args.positionals[0])];
    } catch (e) {
      deps.err(`${(e as Error).message}\n`);
      return 1;
    }
  }
  let failed = 0;
  for (const profile of targets) {
    const result = await checkProfile(profile, deps);
    if (!result.ok) failed++;
    deps.out(formatCheckLine(profile, result));
  }
  const unusable = all ? unusableByName(set.problems) : [];
  for (const [name, reason] of unusable) {
    deps.out(`FAIL  ${name}  -  unusable: ${reason}\n`);
    failed++;
  }
  if (failed > 0) {
    const total = targets.length + unusable.length;
    deps.out(`${failed} of ${total} environments failed\n`);
    return 2;
  }
  return 0;
}
