import {
  describeProfile,
  hostOf,
  isValidProfileName,
  normalizeName,
  ProfileConfigError,
  type ProfileSource,
} from "./profiles.js";
import { ArgError, parseArgs, type ParsedArgs } from "./profileCliArgs.js";
import { checkProfile, formatCheckLine } from "./profileCliTest.js";
import type { ProfileCliDeps } from "./profileCliTypes.js";

const VALUE_FLAGS = [
  "--api-base-url",
  "--api-key",
  "--api-key-env",
  "--endpoint-base-url",
  "--webchat-base-url",
  "--static-files-base-url",
  "--version-hint",
] as const;

class AddFailure extends Error {}

/** Sources that override a saved profile of the same name (see loadProfiles). */
const SHADOWING = new Set<ProfileSource>(["env-profile", "legacy-env"]);

function refusal(name: string, source: ProfileSource): string {
  if (source === "file-profile") {
    return `Profile "${name}" already exists; pass --force to replace it.`;
  }
  if (SHADOWING.has(source)) {
    return `Environment "${name}" is defined by ${source} (environment variables); a saved profile would be shadowed (ignored) by it. Pass --force to save it anyway.`;
  }
  return `Environment "${name}" comes from the legacy single-environment settings in the config file; a saved profile would replace that legacy config. Pass --force to replace it.`;
}

/** Key precedence: --api-key-env, then --api-key, then a hidden prompt. */
async function resolveKey(
  args: ParsedArgs,
  deps: ProfileCliDeps,
): Promise<string> {
  const envVar = args.values["--api-key-env"];
  if (envVar !== undefined) {
    const value = deps.env[envVar]?.trim();
    if (!value) {
      throw new AddFailure(
        `Environment variable ${envVar} is not set or is empty.`,
      );
    }
    return value;
  }
  const given = args.values["--api-key"]?.trim();
  if (given) {
    deps.err(
      "WARNING: --api-key can be stored in your shell history; prefer --api-key-env or the prompt.\n",
    );
    return given;
  }
  if (!deps.isTTY) {
    throw new AddFailure(
      "No API key given: pass --api-key-env <VAR> (or run interactively to be prompted).",
    );
  }
  const typed = (await deps.askHidden("API key: ")).trim();
  if (!typed) throw new AddFailure("An API key is required.");
  return typed;
}

async function resolveUrl(
  args: ParsedArgs,
  deps: ProfileCliDeps,
): Promise<string> {
  const given = args.values["--api-base-url"]?.trim();
  if (given) return given;
  if (!deps.isTTY) {
    throw new AddFailure("--api-base-url is required when not interactive.");
  }
  const typed = (await deps.ask("API base URL: ")).trim();
  if (!typed) throw new AddFailure("An API base URL is required.");
  return typed;
}

const optional = (args: ParsedArgs, flag: string): string | undefined =>
  args.values[flag]?.trim() || undefined;

async function add(args: ParsedArgs, deps: ProfileCliDeps): Promise<number> {
  const name = normalizeName(args.positionals[0] ?? "");
  if (!isValidProfileName(name)) {
    throw new AddFailure(
      `Invalid profile name: use lowercase letters, digits and hyphens, starting with a letter or digit.`,
    );
  }
  const force = args.flags.has("--force");
  const existing = deps.loadProfiles().profiles.find((p) => p.name === name);
  if (existing && !force) throw new AddFailure(refusal(name, existing.source));
  const apiBaseUrl = await resolveUrl(args, deps);
  const apiKey = await resolveKey(args, deps);
  const fields = {
    apiBaseUrl,
    apiKey,
    endpointBaseUrl: optional(args, "--endpoint-base-url"),
    webchatBaseUrl: optional(args, "--webchat-base-url"),
    staticFilesBaseUrl: optional(args, "--static-files-base-url"),
    versionHint: optional(args, "--version-hint"),
  };
  const profile = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as typeof fields;
  try {
    deps.store.upsertProfile(name, profile, { path: deps.configPath });
    if (args.flags.has("--default")) {
      deps.store.setDefaultProfile(name, { path: deps.configPath });
    }
  } catch (e) {
    if (e instanceof ProfileConfigError) throw new AddFailure(e.message);
    throw e;
  }
  const reloaded = deps.loadProfiles().profiles.find((p) => p.name === name);
  const saved = reloaded?.source === "file-profile" ? reloaded : undefined;
  deps.out(
    `Saved profile "${name}" (${saved ? describeProfile(saved).apiHost : hostOf(apiBaseUrl)}).\n`,
  );
  if (existing && SHADOWING.has(existing.source)) {
    deps.err(
      `WARNING: "${name}" is also defined by ${existing.source}; environment variables take precedence over the saved profile.\n`,
    );
  }
  if (args.flags.has("--no-test")) return 0;
  if (!saved) {
    deps.out(
      `Skipped the connection check: "${name}" is currently defined by environment variables, not by the saved profile.\n`,
    );
    return 0;
  }
  const result = await checkProfile(saved, deps);
  if (result.ok) deps.out(formatCheckLine(saved, result));
  else {
    deps.err(
      `WARNING: profile "${name}" was saved, but the connection check failed (${result.detail}).\n`,
    );
  }
  return 0;
}

export async function runAdd(
  tokens: string[],
  deps: ProfileCliDeps,
): Promise<number> {
  try {
    const args = parseArgs("add", tokens, {
      value: VALUE_FLAGS,
      bool: ["--force", "--no-test", "--default"],
    });
    return await add(args, deps);
  } catch (e) {
    if (e instanceof ArgError || e instanceof AddFailure) {
      deps.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
